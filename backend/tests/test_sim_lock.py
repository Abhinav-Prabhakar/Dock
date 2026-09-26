"""SimLock: a request handler must get the sim between two driver steps, not
after the driver's whole burst of back-to-back steps."""

from __future__ import annotations

import threading
import time

from server.episodes import SimLock


def _busy(ms: float) -> None:
    end = time.perf_counter() + ms / 1000
    while time.perf_counter() < end:     # pure Python: holds the GIL, like a sim step
        pass


def test_handler_is_served_between_driver_steps():
    lock = SimLock()
    stop = threading.Event()

    def driver():
        while not stop.is_set():
            with lock.step():
                _busy(5)

    t = threading.Thread(target=driver, daemon=True)
    t.start()
    try:
        time.sleep(0.05)
        waits = []
        for _ in range(40):
            t0 = time.perf_counter()
            with lock:
                waits.append(time.perf_counter() - t0)
            time.sleep(0.005)
    finally:
        stop.set()
        t.join(2)
    # fair: at most ~one 5 ms step; a plain RLock here measures 100-250 ms
    assert max(waits) < 0.05, f"handler waited {max(waits) * 1000:.0f} ms"
    stats = lock.stats()
    assert stats["handler_wait_ms"]["n"] == 40
    assert stats["step_hold_ms"]["n"] > 0


def test_reentrant_for_the_holder():
    lock = SimLock()
    with lock:
        with lock:
            pass
    with lock.step():
        with lock:
            pass
