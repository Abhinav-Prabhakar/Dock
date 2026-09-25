"""FastAPI app factory for the Dock live API.

Run from backend/:

    .venv/bin/python -m uvicorn server.app:app --port 8000
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .episodes import REPO_ROOT, EpisodeManager
from .orders import init_db as init_orders_db
from .routes import router as rest_router
from .ws import router as ws_router


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # DB check at startup, not import: importing server.app must not need a
    # live database (tests build theirs first; tooling imports the module).
    init_orders_db()
    mgr: EpisodeManager = app.state.episodes
    if os.environ.get("DOCK_LIVE", "1") != "0":
        # the always-on world both sites read and customers get quotes from
        mgr.start_live(
            policy=os.environ.get("DOCK_LIVE_POLICY", "ppo"),
            scenario=os.environ.get("DOCK_LIVE_SCENARIO", "baseline"),
            speed_days_per_sec=float(os.environ.get("DOCK_LIVE_SPEED", 1 / 60)))
    yield
    mgr.stop_live()


def create_app() -> FastAPI:
    app = FastAPI(title="Dock API", version="0.1.0", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        # any localhost port: the sites are served by nginx (:8080), by the
        # backend's own /customers mount, or by a plain static server
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.episodes = EpisodeManager()
    app.include_router(rest_router)
    app.include_router(ws_router)
    # customer-facing site, served same-origin at /customers
    cust = REPO_ROOT / "customers"
    if cust.is_dir():
        app.mount("/customers", StaticFiles(directory=cust, html=True),
                  name="customers")
    return app


app = create_app()
