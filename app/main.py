from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import REALTIME_MODEL, STATIC_DIR
from .lesson import LessonError, fetch_lesson, inject_base_href
from .prompts import MODES, build_instructions
from .realtime import RealtimeError, mint_client_secret

app = FastAPI(title="Voice Tutor")


class SessionRequest(BaseModel):
    api_key: str
    lesson_url: str
    language: str = "English"
    mode: str = "overview"


@app.get("/api/modes")
def list_modes():
    return [{"id": key, "label": value["label"]} for key, value in MODES.items()]


@app.get("/api/lesson")
async def lesson_info(url: str):
    """Title and size of a lesson, for the status line before a session starts."""
    try:
        _, text, title = await fetch_lesson(url)
    except LessonError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return {"title": title, "chars": len(text), "text": text}


@app.get("/api/lesson/proxy", response_class=HTMLResponse)
async def lesson_proxy(url: str):
    """Re-serve the lesson page from our own origin so it can be iframed.

    Most sites set X-Frame-Options or frame-ancestors, which blocks framing the
    original URL directly. The iframe sandboxes this: page scripts run so the
    page can render itself, but in an opaque origin that cannot reach ours.
    """
    try:
        html, _, _ = await fetch_lesson(url)
    except LessonError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return HTMLResponse(inject_base_href(html, url))


@app.post("/api/session")
async def create_session(req: SessionRequest):
    if req.mode not in MODES:
        raise HTTPException(400, f"Unknown mode: {req.mode}")

    try:
        _, lesson, title = await fetch_lesson(req.lesson_url)
    except LessonError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    instructions = build_instructions(req.mode, req.language.strip() or "English", lesson)

    try:
        client_secret = await mint_client_secret(req.api_key.strip(), instructions)
    except RealtimeError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    return {
        "client_secret": client_secret,
        "model": REALTIME_MODEL,
        "lesson_title": title,
        "lesson_chars": len(lesson),
    }


# Mounted last so the /api routes above win. html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
