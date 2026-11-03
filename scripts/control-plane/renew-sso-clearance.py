"""Clear a HuntedCow SSO challenge in the worker's Chromium, returning short-lived cookies."""

import asyncio
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
from challenge_browser import click_verification
from guide_browser_environment import prepare_browser_environment
from browser_debug import Reporter, debug_step, quiet_report


CLEARANCE = re.compile(r"^[A-Za-z0-9._-]{1,4096}$")
PROXY = re.compile(r"^socks5://127\.0\.0\.1:\d{1,5}$")
ACCOUNT_PAGE = re.compile(r'<form\b[^>]*id=["\']m-login-form["\']', re.I)
COOKIE_NAMES = {"cf_clearance", "hcs_session_key"}
COOKIE_DOMAINS = {"huntedcow.com", ".huntedcow.com", "account.huntedcow.com"}
CHALLENGE_PAGE = re.compile(r"/cdn-cgi/challenge-platform/|cf[_-]chl[_-]|<title>\s*Just a moment", re.I)


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


async def wait_for_account(tab, seconds: int, report: Reporter = quiet_report) -> bool:
    """Wait for an account page without treating the challenge page as success."""
    for _ in range(seconds // 2):
        if await account_is_loaded(tab, report):
            return True
        await asyncio.sleep(2)
    return await account_is_loaded(tab, report)


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
        if not await wait_for_account(tab, 8, report):
            for _ in range(2):
                report_stage("verification")
                with debug_step("verification", report):
                    await click_verification(tab, profile_directory, report=report)
                report_stage("account_wait_after_verification")
                if await wait_for_account(tab, 35, report):
                    break
            else:
                raise TimeoutError("HuntedCow verification did not reach the account form")

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
    finally:
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
