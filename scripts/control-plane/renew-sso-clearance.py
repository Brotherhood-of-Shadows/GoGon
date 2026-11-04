"""Clear a HuntedCow SSO challenge in the worker's Chromium, returning short-lived cookies."""

import asyncio
import errno
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse
from typing import Literal

import nodriver
from challenge_browser import verify_until
from guide_browser_environment import prepare_browser_environment
from browser_debug import Reporter, debug_step, quiet_report


CLEARANCE = re.compile(r"^[A-Za-z0-9._-]{1,4096}$")
PROXY = re.compile(r"^socks5://127\.0\.0\.1:\d{1,5}$")
ACCOUNT_PAGE = re.compile(r'<form\b[^>]*id=["\']m-login-form["\']', re.I)
COOKIE_NAMES = {"cf_clearance", "hcs_session_key"}
COOKIE_DOMAINS = {"huntedcow.com", ".huntedcow.com", "account.huntedcow.com"}
CHALLENGE_PAGE = re.compile(r"/cdn-cgi/challenge-platform/|cf[_-]chl[_-]|<title>\s*Just a moment", re.I)
FAILURE_IMAGE_DIRECTORY = Path('/var/lib/gogon-sso-debug')
# Polling budget for the shared checkbox loop (challenge_browser.verify_until).
VERIFICATION_SECONDS = 70


def preserve_failure_image(profile_directory: Path, report: Reporter) -> None:
    """Retain the existing pre-interaction image as PNG without replacing the original login error."""
    temporary_path = None
    try:
        source = profile_directory / 'challenge.png'
        if not source.is_file():
            report('failure_image_source_missing', 'observed')
            return
        if not 8 <= source.stat().st_size <= 5 * 1024 * 1024:
            report('failure_image_size_invalid', 'observed')
            return
        data = source.read_bytes()
        # nodriver 0.50.3 defaults to JPEG regardless of the filename extension. Normalize the
        # diagnostic copy after failure; leave the original capture and interaction untouched.
        if data.startswith(b'\xff\xd8\xff'):
            try:
                import cv2
            except ImportError:
                report('failure_image_decode_failed', 'observed')
                return
            try:
                image = cv2.imread(str(source), cv2.IMREAD_UNCHANGED)
                if image is None:
                    report('failure_image_decode_failed', 'observed')
                    return
                encoded, buffer = cv2.imencode('.png', image)
                if not encoded:
                    report('failure_image_decode_failed', 'observed')
                    return
                data = buffer.tobytes()
            except cv2.error:
                report('failure_image_decode_failed', 'observed')
                return
        if not data.startswith(b'\x89PNG\r\n\x1a\n'):
            report('failure_image_format_invalid', 'observed')
            return
        if len(data) > 5 * 1024 * 1024:
            report('failure_image_size_invalid', 'observed')
            return
        FAILURE_IMAGE_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=FAILURE_IMAGE_DIRECTORY, prefix='.failure-', delete=False) as target:
            temporary_path = Path(target.name)
            target.write(data)
        temporary_path.replace(FAILURE_IMAGE_DIRECTORY / 'last-failure.png')
        temporary_path = None
        report('failure_image_saved', 'observed')
    except PermissionError:
        report('failure_image_permission_denied', 'observed')
    except OSError as error:
        report('failure_image_read_only' if error.errno == errno.EROFS else 'failure_image_io_error', 'observed')
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def report_stage(stage: Literal["browser_start", "navigation", "account_wait", "verification",
                                "account_wait_after_verification", "cookies", "user_agent"]) -> None:
    """Write a code-owned stage to stderr; stdout remains reserved for secret result data."""
    print(f"[SSO_STAGE:{stage}]", file=sys.stderr, flush=True)


async def account_is_loaded(tab, report: Reporter = quiet_report) -> bool:
    """Return whether the browser has reached the HuntedCow account form."""
    with debug_step("page_content", report):
        html = await tab.get_content()
    loaded = bool(ACCOUNT_PAGE.search(html))
    page = "account_form" if loaded else "challenge" if CHALLENGE_PAGE.search(html) else "other"
    report(f"page_{page}", "observed")
    print(f"[SSO_PAGE:{page}]", file=sys.stderr, flush=True)
    return loaded


async def verify_until_account(tab, profile_directory: Path, seconds: float,
                               report: Reporter = quiet_report) -> bool:
    """Reach the HuntedCow account form through the shared checkbox polling loop."""
    return await verify_until(tab, profile_directory, lambda: account_is_loaded(tab, report), seconds,
                              not_reached="HuntedCow verification did not reach the account form",
                              report=report, stage=report_stage)


async def renew(entry_url: str) -> None:
    """Run verification, outputting only validated HuntedCow cookies and browser User-Agent."""
    started_at = time.monotonic()

    def report(operation: str, event: str) -> None:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        print(f"[SSO_DEBUG:{operation}:{event}:{elapsed_ms}]", file=sys.stderr, flush=True)

    parsed = urlparse(entry_url)
    if parsed.scheme != "https" or parsed.hostname not in ("huntedcow.com", "account.huntedcow.com") \
            or parsed.path != "/auth":
        raise ValueError("Invalid HuntedCow SSO entry URL")

    browser_path = os.environ.get("GG_GUIDE_CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
    if not browser_path:
        raise FileNotFoundError("Chromium is unavailable")
    browser_args = ["--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
                    "--disable-dev-shm-usage"]
    proxy = os.environ.get("GG_GUIDE_BROWSER_PROXY")
    if proxy:
        if not PROXY.fullmatch(proxy):
            raise ValueError("GG_GUIDE_BROWSER_PROXY must be a local SOCKS5 endpoint")
        browser_args.append(f"--proxy-server={proxy}")
    if os.environ.get("GG_GUIDE_BROWSER_OFFSCREEN") == "1":
        browser_args.append("--window-position=-32000,-32000")

    profile_directory = Path(tempfile.mkdtemp(prefix="gogon-sso-clearance-"))
    prepare_browser_environment(profile_directory)
    browser = None
    completed = False
    try:
        report_stage("browser_start")
        with debug_step("browser_start", report):
            browser = await nodriver.start(
                browser_executable_path=browser_path,
                user_data_dir=profile_directory,
                browser_args=browser_args,
                headless=False,
                expert=False,
                sandbox=False if os.name == "posix" else True,
            )
        report_stage("navigation")
        with debug_step("navigation", report):
            tab = await browser.get(entry_url)
        report_stage("account_wait")
        await verify_until_account(tab, profile_directory, VERIFICATION_SECONDS, report)

        report_stage("cookies")
        with debug_step("cookies", report):
            cookies = await browser.cookies.get_all()
        selected = [{"name": cookie.name, "value": cookie.value, "domain": cookie.domain,
                     "path": cookie.path or "/", "secure": bool(cookie.secure)}
                    for cookie in cookies if cookie.name in COOKIE_NAMES and cookie.domain in COOKIE_DOMAINS]
        if not any(cookie["name"] == "cf_clearance" for cookie in selected) \
                or any(not CLEARANCE.fullmatch(cookie["value"]) for cookie in selected):
            raise ValueError("HuntedCow verification produced no usable clearance")
        report_stage("user_agent")
        with debug_step("user_agent", report):
            user_agent = await tab.evaluate("navigator.userAgent")
        if not isinstance(user_agent, str) or not 1 <= len(user_agent) <= 300 \
                or any(ord(character) < 32 or ord(character) == 127 for character in user_agent):
            raise ValueError("HuntedCow browser produced an invalid user agent")
        print(json.dumps({"cookies": selected, "userAgent": user_agent}), flush=True)
        completed = True
    finally:
        if not completed:
            preserve_failure_image(profile_directory, report)
        if browser is not None:
            with debug_step("browser_stop", report):
                browser.stop()
        await asyncio.sleep(1)
        for attempt in range(5):
            try:
                with debug_step("profile_cleanup", report):
                    shutil.rmtree(profile_directory)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                await asyncio.sleep(1)


if __name__ == "__main__":
    nodriver.loop().run_until_complete(asyncio.wait_for(renew(sys.argv[1]), timeout=90))
