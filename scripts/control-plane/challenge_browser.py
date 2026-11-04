"""Shared Cloudflare checkbox verification for the Guide and HuntedCow browsers."""

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path

import cv2
from browser_debug import Reporter, debug_step, quiet_report


# Each template is centred on the checkbox. The light one is cut from this container's own
# Chromium rendering of the widget, which the Guide and HuntedCow share (its fonts differ from
# desktop browsers); the dark one is the original Guide capture. Inverted contrast never
# correlates, so both are tried.
CHECKBOX_TEMPLATES = (
    Path(__file__).with_name("sso-checkbox-template.png"),
    Path(__file__).with_name("guide-checkbox-template.png"),
)
# A visible checkbox scores 1.0 against the light template; the "Verifying..." spinner ~0.6.
MATCH_THRESHOLD = 0.75
# The widget first shows "Verifying..." (over 12 s on the VPS) before its checkbox appears, and
# may also pass on its own, so poll both instead of judging one early screenshot. Never search
# page or frame text: that lookup stalled while the widget was still verifying.
POLL_SECONDS = 1.5
MAX_CLICKS = 2
AFTER_CLICK_SECONDS = 20


def _no_stage(stage: str) -> None:
    """Callers without stage reporting stay quiet."""


async def locate_checkbox(tab, profile_directory: Path, *, report: Reporter = quiet_report):
    """Return the screen centre of a visible verification checkbox, or None while it is absent.

    The latest screenshot stays at ``challenge.png`` in the profile for failure diagnostics.
    """
    screenshot_path = profile_directory / "challenge.png"
    with debug_step("screenshot", report):
        await tab.save_screenshot(str(screenshot_path), format="png")
    with debug_step("screenshot_read", report):
        screenshot = cv2.imread(str(screenshot_path), cv2.IMREAD_GRAYSCALE)
    with debug_step("template_read", report):
        templates = [cv2.imread(str(path), cv2.IMREAD_GRAYSCALE) for path in CHECKBOX_TEMPLATES]
    if screenshot is None or any(template is None for template in templates):
        raise FileNotFoundError("Challenge image is unavailable")
    best = None
    with debug_step("image_match", report):
        for template in templates:
            if template.shape[0] > screenshot.shape[0] or template.shape[1] > screenshot.shape[1]:
                continue
            matches = cv2.matchTemplate(screenshot, template, cv2.TM_CCOEFF_NORMED)
            _, score, _, position = cv2.minMaxLoc(matches)
            if score >= MATCH_THRESHOLD and (best is None or score > best[0]):
                best = (score, position[0] + template.shape[1] // 2, position[1] + template.shape[0] // 2)
    return None if best is None else best[1:]


async def click_checkbox_image(tab, profile_directory: Path, *, report: Reporter = quiet_report) -> bool:
    """Click the checkbox when a template matches; return whether a click happened."""
    point = await locate_checkbox(tab, profile_directory, report=report)
    if point is None:
        return False
    with debug_step("image_click", report):
        await tab.mouse_click(*point)
    return True


async def verify_until(tab, profile_directory: Path, is_loaded: Callable[[], Awaitable[bool]], seconds: float, *,
                       not_reached: str, report: Reporter = quiet_report,
                       stage: Callable[[str], None] = _no_stage) -> bool:
    """Wait until ``is_loaded`` holds, clicking the checkbox by image whenever it is visible.

    Raises TimeoutError("Verification checkbox did not appear") when no checkbox was ever
    clicked, or TimeoutError(not_reached) when clicks did not lead to the protected page.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    clicks = 0
    while True:
        if await is_loaded():
            return True
        if loop.time() >= deadline:
            break
        if clicks < MAX_CLICKS:
            stage("verification")
            with debug_step("verification", report):
                clicked = await click_checkbox_image(tab, profile_directory, report=report)
            if clicked:
                clicks += 1
                stage("account_wait_after_verification")
                settle = loop.time() + max(2.0, min(AFTER_CLICK_SECONDS, deadline - loop.time()))
                while loop.time() < settle:
                    await asyncio.sleep(POLL_SECONDS)
                    if await is_loaded():
                        return True
                stage("account_wait")
                continue
        await asyncio.sleep(POLL_SECONDS)
    if clicks:
        raise TimeoutError(not_reached)
    raise TimeoutError("Verification checkbox did not appear")
