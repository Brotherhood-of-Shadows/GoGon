"""Shared visual verification interaction for the Guide and HuntedCow browsers."""

import asyncio
from pathlib import Path

import cv2
from browser_debug import BrowserOperationTimeout, Reporter, debug_step, quiet_report


LABELS = ("Verify you are human", "Confirme que é humano")
# Each template is centred on the checkbox. The light one is cut from this container's own
# Chromium rendering of the HuntedCow widget (its fonts differ from desktop browsers); the dark
# one is the original Guide capture. Inverted contrast never correlates, so both are needed.
CHECKBOX_TEMPLATES = (
    Path(__file__).with_name("sso-checkbox-template.png"),
    Path(__file__).with_name("guide-checkbox-template.png"),
)
CHECKBOX_TEMPLATE = CHECKBOX_TEMPLATES[1]
# A visible checkbox scores 1.0 against the light template; the "Verifying..." spinner ~0.6.
MATCH_THRESHOLD = 0.75


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
    """Click the checkbox when a template matches; never performs a DOM/frame text lookup."""
    point = await locate_checkbox(tab, profile_directory, report=report)
    if point is None:
        return False
    with debug_step("image_click", report):
        await tab.mouse_click(*point)
    return True


async def click_verification(tab, profile_directory: Path, *, report: Reporter = quiet_report) -> None:
    """Click the visible verification checkbox by image, falling back to its label text."""
    if await click_checkbox_image(tab, profile_directory, report=report):
        return

    for label in LABELS:
        operation = "label_lookup_en" if label == LABELS[0] else "label_lookup_pt"
        with debug_step(operation, report):
            lookup_seconds = 10 if label == LABELS[0] else 3
            # nodriver's timeout only bounds its polling loop; an awaited frame/CDP call can
            # stall before the loop checks elapsed time. Allow two seconds for its final poll,
            # then abort the attempt instead of consuming the whole browser-helper deadline.
            deadline = asyncio.timeout(lookup_seconds + 2)
            try:
                async with deadline:
                    element = await tab.find(label, timeout=lookup_seconds)
            except TimeoutError as error:
                if deadline.expired():
                    raise BrowserOperationTimeout("Browser label lookup exceeded hard deadline") from error
                raise
        if element:
            with debug_step("label_click", report):
                await element.mouse_click()
            return
    raise TimeoutError("Verification checkbox did not appear")
