"""WebSocket live stream for episodes.

WS /episodes/{id}/stream: replays the buffered event log, then forwards
live events until the episode reaches a terminal status, at which point a
final {"type":"episode.status", ...} message is sent and the socket is
closed.

The sim thread emits events synchronously; each WS connection owns a plain
thread-safe ``queue.Queue`` subscriber and consumes it via
``asyncio.to_thread`` — the simplest correct sync->async bridge.
"""

from __future__ import annotations

import asyncio
import queue

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .episodes import TERMINAL

router = APIRouter()

POLL_TIMEOUT_S = 0.5


@router.websocket("/episodes/{ep_id}/stream")
async def episode_stream(ws: WebSocket, ep_id: str):
    mgr = ws.app.state.episodes
    ep = mgr.get(ep_id)
    if ep is None:
        await ws.close(code=4404)
        return
    await ws.accept()
    # subscribe BEFORE snapshotting so nothing is lost in between; the
    # seq check below drops events already covered by the replay.
    q = ep.subscribe()
    try:
        with ep._lock:
            backlog = list(ep.events)
        last_seq = -1
        for ev in backlog:
            await ws.send_json(ev)
            last_seq = ev.get("seq", last_seq)
        while True:
            try:
                ev = await asyncio.to_thread(q.get, True, POLL_TIMEOUT_S)
            except queue.Empty:
                ev = None
            if ev is None:
                if ep.status in TERMINAL:
                    await ws.send_json({"type": "episode.status",
                                        "status": ep.status,
                                        "day": ep.day})
                    return
                continue
            seq = ev.get("seq", -1)
            if seq <= last_seq:          # already replayed
                continue
            last_seq = seq
            await ws.send_json(ev)
            if ev.get("type") == "episode.status" \
                    and ev.get("status") in TERMINAL:
                return
    except (WebSocketDisconnect, RuntimeError):
        return
    finally:
        ep.unsubscribe(q)
        try:
            await ws.close()
        except Exception:
            pass
