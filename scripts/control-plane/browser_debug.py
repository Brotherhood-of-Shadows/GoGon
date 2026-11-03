"""Operation boundaries for browser diagnostics, without recording browser data."""

from collections.abc import Callable, Iterator
from contextlib import contextmanager

Reporter = Callable[[str, str], None]


class BrowserOperationTimeout(TimeoutError):
    """A browser operation exceeded its outer wall-clock deadline."""


def quiet_report(operation: str, event: str) -> None:
    """Leave shared Guide interactions quiet unless a caller supplies a reporter."""


@contextmanager
def debug_step(operation: str, report: Reporter) -> Iterator[None]:
    """Report start/completion or interruption without changing exceptions or cancellation."""
    report(operation, "start")
    completed = False
    try:
        yield
        completed = True
    finally:
        report(operation, "done" if completed else "interrupted")
