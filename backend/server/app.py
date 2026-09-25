"""FastAPI app factory for the Dock live API.

Run from backend/:

    .venv/bin/python -m uvicorn server.app:app --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .episodes import REPO_ROOT, EpisodeManager
from .orders import init_db as init_orders_db
from .routes import router as rest_router
from .ws import router as ws_router

CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def create_app() -> FastAPI:
    app = FastAPI(title="Dock API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        # the customer site is also served as plain static files (python
        # http.server etc.) on whatever localhost port is free
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.episodes = EpisodeManager()
    init_orders_db()
    app.include_router(rest_router)
    app.include_router(ws_router)
    # customer-facing site, served same-origin at /customers
    cust = REPO_ROOT / "customers"
    if cust.is_dir():
        app.mount("/customers", StaticFiles(directory=cust, html=True),
                  name="customers")
    return app


app = create_app()
