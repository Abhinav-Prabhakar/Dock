"""FastAPI app factory for the Dock live API.

Run from backend/:

    .venv/bin/python -m uvicorn server.app:app --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .episodes import EpisodeManager
from .routes import router as rest_router
from .ws import router as ws_router

CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def create_app() -> FastAPI:
    app = FastAPI(title="Dock API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.episodes = EpisodeManager()
    app.include_router(rest_router)
    app.include_router(ws_router)
    return app


app = create_app()
