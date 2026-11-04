"""Issue a fresh guide clearance in a real Chromium session on the worker's network."""

import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import nodriver
from challenge_browser import verify_until
from guide_browser_environment import prepare_browser_environment


GUIDE_URL = "https://guide.fallensword.com/index.php?cmd=items&index=0"
GUIDE_LINK = re.compile(r'<a\b[^>]*href=["\'][^"\']*index\.php\?cmd=', re.I)
CLEARANCE = re.compile(r"^[A-Za-z0-9._-]{1,4096}$")
PROXY = re.compile(r"^socks5://127\.0\.0\.1:\d{1,5}$")
# Polling budget for the shared checkbox loop; the Guide shows the same widget as HuntedCow.
VERIFICATION_SECONDS = 70


async def guide_is_loaded(tab):
    return bool(GUIDE_LINK.search(await tab.get_content()))


async def renew():
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

    profile_directory = Path(tempfile.mkdtemp(prefix="gogon-guide-clearance-"))
    prepare_browser_environment(profile_directory)
    browser = None
    try:
        browser = await nodriver.start(
            browser_executable_path=browser_path,
            user_data_dir=profile_directory,
            browser_args=browser_args,
            headless=False,
            expert=False,
            sandbox=False if os.name == "posix" else True,
        )
        tab = await browser.get(GUIDE_URL)
        await verify_until(tab, profile_directory, lambda: guide_is_loaded(tab), VERIFICATION_SECONDS,
                           not_reached="Guide verification did not reach guide content")

        cookies = await browser.cookies.get_all()
        clearance = next((cookie.value for cookie in cookies if cookie.name == "cf_clearance"
                          and cookie.domain.lstrip(".") in ("fallensword.com", "guide.fallensword.com")), None)
        user_agent = await tab.evaluate("navigator.userAgent")
        if not clearance or not CLEARANCE.fullmatch(clearance):
            raise ValueError("Guide verification produced no usable clearance")
        if not isinstance(user_agent, str) or not 1 <= len(user_agent) <= 300 \
                or any(ord(character) < 32 or ord(character) == 127 for character in user_agent):
            raise ValueError("Guide browser produced an invalid user agent")
        print(json.dumps({"clearance": clearance, "userAgent": user_agent}), flush=True)
    finally:
        if browser is not None:
            browser.stop()
        await asyncio.sleep(1)
        for attempt in range(5):
            try:
                shutil.rmtree(profile_directory)
                break
            except PermissionError:
                if attempt == 4:
                    raise
                await asyncio.sleep(1)


if __name__ == "__main__":
    nodriver.loop().run_until_complete(asyncio.wait_for(renew(), timeout=90))
