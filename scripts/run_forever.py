"""
Keeps biasapp.net's data fresh without GitHub: builds the report on the same schedule the GitHub workflow used,
then uploads the files the app reads to the Cloudflare R2 bucket the worker serves them from.

Run it as one always-on task (PythonAnywhere "Always-on tasks", or any small server):
    python3 scripts/run_forever.py

Settings come from environment variables (never put them in this file):
    R2_ACCOUNT_ID         Cloudflare account ID
    R2_ACCESS_KEY_ID      R2 API token: Access Key ID   (R2 → Manage API tokens → Object Read & Write, this bucket only)
    R2_SECRET_ACCESS_KEY  R2 API token: Secret Access Key
    R2_BUCKET             bucket name the worker has bound as FILES
    FRED_API_KEY          optional, same as before
Put them in a file named .env next to this folder (one NAME=value per line) and this script loads it.

    python3 scripts/run_forever.py --once     build and upload one time, then exit (to test the setup)
"""
import os
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
UTC = ZoneInfo("UTC")
# the files the worker serves to the app (worker.js SERVED_DATA); history and internals stay on this machine
SERVED = ["latest.json", "calendar.json", "expmove.json", "news.json", "tools.json"]


def load_env():
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def due(t: datetime) -> bool:
    """The GitHub workflow's cron schedule (UTC), checked minute by minute."""
    wd = (t.weekday() + 1) % 7          # cron weekday: 0 = Sunday
    m, h = t.minute, t.hour
    if wd in range(1, 6) and h in (12, 13, 14) and m in (7, 22, 37, 52):
        return True                     # New York pre-open
    if wd in range(0, 6) and m in (10, 40):
        return True                     # re-checks for whichever session is open
    if wd in range(1, 6) and 14 <= h <= 20 and m in (25, 55):
        return True                     # extra New York re-checks
    if wd in range(1, 6) and h in (6, 7) and m == 45:
        return True                     # London lock
    if wd in range(0, 5) and h in (22, 23) and m == 45:
        return True                     # Asia lock
    if wd in range(0, 5) and h in (20, 21, 22) and m in (20, 50):
        return True                     # before the Globex reopen
    return False


def upload():
    import boto3
    acct, bucket = os.environ["R2_ACCOUNT_ID"], os.environ["R2_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=f"https://{acct}.r2.cloudflarestorage.com",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto")
    n = 0
    for name in SERVED:
        p = DATA / name
        if p.exists():
            s3.put_object(Bucket=bucket, Key=f"data/{name}", Body=p.read_bytes(),
                          ContentType="application/json", CacheControl="no-store")
            n += 1
    return n


def build_and_publish():
    t0 = time.time()
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_report.py")], cwd=ROOT, timeout=50 * 60)
    if r.returncode != 0:
        print(f"{datetime.now(UTC):%Y-%m-%d %H:%M}Z build failed (exit {r.returncode})", flush=True)
    n = upload()
    print(f"{datetime.now(UTC):%Y-%m-%d %H:%M}Z built in {time.time() - t0:.0f}s, uploaded {n} files", flush=True)


def main():
    load_env()
    missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not os.environ.get(k)]
    if missing:
        sys.exit("Missing settings: " + ", ".join(missing) + ". Put them in the .env file (see the top of this script).")
    if "--once" in sys.argv:
        build_and_publish()
        return
    print("Running. Builds on the old GitHub schedule and uploads to R2.", flush=True)
    last = None
    while True:
        now = datetime.now(UTC).replace(second=0, microsecond=0)
        if now != last and due(now):
            last = now
            try:
                build_and_publish()
            except Exception:  # noqa: BLE001  keep running whatever happens; the next slot tries again
                traceback.print_exc()
        nxt = datetime.now(UTC).replace(second=0, microsecond=0) + timedelta(minutes=1)
        time.sleep(max(1.0, (nxt - datetime.now(UTC)).total_seconds() + 1))


if __name__ == "__main__":
    main()
