"""Small shop-side print worker. Python 3.10+, standard library only."""
import json
import logging
import logging.handlers
import mimetypes
import os
import pathlib
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CONFIG_PATH = pathlib.Path(os.environ.get("PRINT_AGENT_CONFIG", ROOT / "config.json"))
STATE_PATH = pathlib.Path(os.environ.get("PRINT_AGENT_STATE", ROOT / "agent-state.sqlite3"))
LOG_PATH = pathlib.Path(os.environ.get("PRINT_AGENT_LOG", ROOT / "print-agent.log"))
logger = logging.getLogger("print-wallah-agent")


def read_config():
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Create {CONFIG_PATH} from config.example.json first")
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        config = json.load(handle)
    for key in ("server_url", "shop_id", "agent_token", "printer_name"):
        if not str(config.get(key, "")).strip():
            raise RuntimeError(f"Missing {key} in {CONFIG_PATH}")
    command = config.get("print_command")
    if isinstance(command, str):
        command = shlex.split(command, posix=os.name != "nt")
    if not isinstance(command, list) or not command or not any("{file}" in item for item in command):
        raise RuntimeError("Set print_command to an argument array containing the {file} placeholder")
    config["print_command"] = command
    config["server_url"] = config["server_url"].rstrip("/")
    config["poll_seconds"] = max(3, min(120, int(config.get("poll_seconds", 8))))
    return config


def request(config, endpoint, method="GET", body=None, binary=False):
    url = config["server_url"] + endpoint
    headers = {"Authorization": "Bearer " + config["agent_token"], "User-Agent": "PrintWallahPrintAgent/1.0"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            payload = response.read()
            return payload if binary else json.loads(payload.decode("utf-8")) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read(300).decode("utf-8", errors="replace")
        raise RuntimeError(f"Server returned HTTP {error.code}: {detail}") from error


def init_state():
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(STATE_PATH)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    finally:
        db.close()


def previous_state(job_id):
    db = sqlite3.connect(STATE_PATH)
    try:
        row = db.execute("SELECT state FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        return row[0] if row else None
    finally:
        db.close()


def save_state(job_id, state):
    db = sqlite3.connect(STATE_PATH)
    try:
        db.execute("INSERT INTO jobs(job_id,state) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,updated_at=CURRENT_TIMESTAMP", (job_id, state))
        db.commit()
    finally:
        db.close()


def safe_filename(value):
    name = pathlib.Path(value or "print-job.pdf").name
    name = re.sub(r"[^a-zA-Z0-9._-]", "_", name)[:120]
    return name or "print-job.pdf"


def print_job(config, job):
    job_id = job["job_id"]
    prior = previous_state(job_id)
    if prior == "completed":
        logger.warning("Job %s was already completed locally; acknowledging without printing again", job["order_code"])
        report(config, job_id, "completed")
        return
    if prior == "started":
        message = "Previous print attempt stopped before a result was recorded. Check the printer output, then retry from the shop dashboard."
        logger.error("Job %s has an uncertain previous attempt; refusing automatic duplicate print", job["order_code"])
        report(config, job_id, "failed", message)
        return

    options = job["config"]
    required = []
    if int(job["copies"]) > 1:
        required.append("{copies}")
    if options.get("pageRange", "all") != "all":
        required.append("{page_range}")
    if options.get("color"):
        required.append("{color}")
    if options.get("duplex"):
        required.append("{duplex}")
    if options.get("paperSize", "A4") != "A4":
        required.append("{paper_size}")
    if options.get("orientation", "portrait") != "portrait":
        required.append("{orientation}")
    if options.get("scaling", "fit") != "fit":
        required.append("{scaling}")
    missing = [placeholder for placeholder in required if not any(placeholder in item for item in config["print_command"])]
    if missing:
        message = "Print command does not support selected setting(s): " + ", ".join(missing)
        logger.error("Order %s cannot print: %s", job["order_code"], message)
        save_state(job_id, "failed")
        report(config, job_id, "failed", message)
        return

    download_path = urllib.parse.urlparse(job["downloadUrl"]).path
    document = request(config, download_path, binary=True)
    suffix = pathlib.Path(safe_filename(job["original_name"])).suffix or ".pdf"
    with tempfile.NamedTemporaryFile(prefix="print-wallah-", suffix=suffix, delete=False) as temp:
        temp.write(document)
        filename = temp.name
    page_count = int(options.get("printPageCount") or options.get("sourcePageCount") or job["page_count"])
    requested_range = options.get("pageRange", "all")
    config_values = {
        "file": filename,
        "printer": config["printer_name"],
        "copies": str(job["copies"]),
        "page_range": requested_range if requested_range != "all" else f"1-{page_count}",
        "paper_size": str(options.get("paperSize", "A4")),
        "color": "color" if options.get("color") else "monochrome",
        "duplex": "two-sided-long-edge" if options.get("duplex") else "one-sided",
        "orientation": "4" if options.get("orientation") == "landscape" else "3",
        "scaling": {"fit": "fit", "fill": "fill", "actual": "none"}.get(options.get("scaling", "fit"), "fit"),
        "order_code": job["order_code"],
    }
    command = [part.format(**config_values) for part in config["print_command"]]
    command = [part for part in command if part]
    save_state(job_id, "started")
    try:
        logger.info("Sending order %s to printer %s", job["order_code"], config["printer_name"])
        with Heartbeat(config):
            result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=15 * 60)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or f"Print command exited {result.returncode}")[:900]
            save_state(job_id, "failed")
            report(config, job_id, "failed", message)
            logger.error("Print failed for %s: %s", job["order_code"], message[:250])
            return
        save_state(job_id, "completed")
        report(config, job_id, "completed")
        logger.info("Print command accepted order %s", job["order_code"])
    except Exception as error:
        save_state(job_id, "started")
        report(config, job_id, "failed", str(error)[:900])
        logger.exception("Print attempt failed for %s", job["order_code"])
    finally:
        try:
            os.unlink(filename)
        except OSError:
            pass


class Heartbeat:
    """Keeps the shop marked online while a long print command runs (the main loop is blocked meanwhile)."""

    def __init__(self, config, interval=20):
        self.config, self.interval, self.stop = config, interval, threading.Event()

    def __enter__(self):
        def loop():
            while not self.stop.wait(self.interval):
                try:
                    request(self.config, f"/api/agent/{urllib.parse.quote(self.config['shop_id'])}/heartbeat", "POST", {"agentName": self.config.get("agent_name", "Shop print agent")})
                except Exception as error:  # a missed heartbeat must never affect the print itself
                    logger.warning("Heartbeat during print failed: %s", error)
        threading.Thread(target=loop, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.stop.set()


def report(config, job_id, status, error=None):
    body = {"status": status}
    if error:
        body["error"] = error
    request(config, f"/api/agent/{urllib.parse.quote(config['shop_id'])}/jobs/{urllib.parse.quote(job_id)}/result", "POST", body)


def run():
    handler = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stdout)], format="%(asctime)s %(levelname)s %(message)s")
    config = read_config()
    init_state()
    logger.info("Print Wallah agent started for shop %s", config["shop_id"])
    base = f"/api/agent/{urllib.parse.quote(config['shop_id'])}"
    while True:
        try:
            request(config, base + "/heartbeat", "POST", {"agentName": config.get("agent_name", "Shop print agent")})
            result = request(config, base + "/jobs")
            if result.get("job"):
                print_job(config, result["job"])
            else:
                time.sleep(config["poll_seconds"])
        except KeyboardInterrupt:
            logger.info("Agent stopped by operator")
            return
        except Exception as error:
            logger.error("Connection or job error: %s", error)
            time.sleep(config["poll_seconds"])


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        print(f"Print agent cannot start: {error}", file=sys.stderr)
        sys.exit(1)
