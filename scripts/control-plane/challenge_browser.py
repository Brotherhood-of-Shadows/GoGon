"""Shared visual verification interaction for the Guide and HuntedCow browsers."""

import asyncio
from pathlib import Path

import cv2
from browser_debug import BrowserOperationTimeout, Reporter, debug_step, quiet_report


LABELS = ("Verify you are human", "Confirme que \u00e9 humano")
CHECKBOX_TEMPLATE = Path(__file__).with_name("guide-checkbox-template.png")


async def click_verification(tab, profile_directory: Path, *, report: Reporter = quiet_report) -> None:
    """Click the visible verification checkbox using the existing Guide image template."""
    screenshot_path = profile_directory / "challenge.png"
    with debug_step("screenshot", report):
        await tab.save_screenshot(str(screenshot_path))
    with debug_step("screenshot_read", report):
        screenshot = cv2.imread(str(screenshot_path), cv2.IMREAD_GRAYSCALE)
    with debug_step("template_read", report):
        checkbox_template = cv2.imread(str(CHECKBOX_TEMPLATE), cv2.IMREAD_GRAYSCALE)
    if screenshot is None or checkbox_template is None:
        raise FileNotFoundError("Challenge image is unavailable")
    with debug_step("image_match", report):
        matches = cv2.matchTemplate(screenshot, checkbox_template, cv2.TM_CCOEFF_NORMED)
        _, score, _, position = cv2.minMaxLoc(matches)
    if score >= 0.75:
        checkbox_x = position[0] + checkbox_template.shape[1] // 2
        checkbox_y = position[1] + checkbox_template.shape[0] // 2
        with debug_step("image_click", report):
            await tab.mouse_click(checkbox_x, checkbox_y)
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
