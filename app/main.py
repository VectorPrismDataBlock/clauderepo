import base64
import uuid

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .assess import AssessError, assess
from .config import (
    ASSESS_MODEL,
    DEFAULT_SESSION_BUDGET_USD,
    ENGINES,
    INPUT_TRANSCRIPTION_MODEL,
    PIPELINE_CHAT_MODEL,
    PIPELINE_TRANSCRIPTION_MODEL,
    PRICING,
    SPEECH_MIN_CHARS,
    SPEECH_MODEL,
    SPEECH_VOICE,
    SPEECH_VOICES,
    VOICE_MODES,
    PRICING_AS_OF,
    REALTIME_MODEL,
    STATIC_DIR,
    VERDICT_SCORES,
)
from .lesson import LessonError, fetch_lesson, inject_base_href
from .pipeline import PipelineError, stream_reply, transcribe
from .speech import SpeechError, mime_type, synthesize
from .prompts import MODES, build_instructions
from .realtime import RealtimeError, mint_client_secret
from .session import TutorSession, sessions

app = FastAPI(title="Voice Tutor")


class SessionRequest(BaseModel):
    api_key: str
    lesson_url: str
    engine: str = "realtime"
    language: str = "English"
    mode: str = "overview"
    listening_mode: str = "auto"
    difficulty: str = "intermediate"
    pace: str = "normal"
    memory: str = ""
    voice_mode: str = "browser"
    voice: str = SPEECH_VOICE


class AssessRequest(BaseModel):
    api_key: str
    question: str
    answer: str
    lesson_title: str = ""
    language: str = "English"
    # Looked up server-side for the lesson text. Grading without it is blind.
    session_id: str = ""


@app.get("/api/modes")
def list_modes():
    return [{"id": key, "label": value["label"]} for key, value in MODES.items()]


@app.get("/api/voices")
def list_voices():
    """Voice options for the turn-based engine. Realtime picks its own."""
    return {
        "modes": [{"id": k, "label": v} for k, v in VOICE_MODES.items()],
        "openai_voices": SPEECH_VOICES,
        "default_voice": SPEECH_VOICE,
    }


@app.get("/api/engines")
def list_engines():
    return [
        {"id": key, "label": value["label"], "description": value["description"]}
        for key, value in ENGINES.items()
    ]


@app.get("/api/pricing")
def pricing():
    """Rates for the cost ticker. The browser does the arithmetic so both
    engines are priced by one implementation."""
    return {
        "as_of": PRICING_AS_OF,
        "rates": PRICING,
        "default_budget_usd": DEFAULT_SESSION_BUDGET_USD,  # keyed by engine
        "models": {
            "realtime": REALTIME_MODEL,
            "realtime_stt": INPUT_TRANSCRIPTION_MODEL,
            "pipeline_chat": PIPELINE_CHAT_MODEL,
            "pipeline_stt": PIPELINE_TRANSCRIPTION_MODEL,
            "assess": ASSESS_MODEL,
            "speech": SPEECH_MODEL,
        },
        "verdict_scores": VERDICT_SCORES,
    }


@app.post("/api/assess")
async def assess_answer(req: AssessRequest):
    """Grade one exchange. Called after the reply is already playing, so this
    never sits in front of the student."""
    session = sessions.get(req.session_id) if req.session_id else None

    try:
        assessment, usage = await assess(
            req.api_key.strip(),
            req.lesson_title,
            req.question,
            req.answer,
            req.language,
            lesson=session.lesson if session else "",
        )
    except AssessError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    return {
        "assessment": assessment,
        "usage": usage,
        "model": ASSESS_MODEL,
        # The gauge is only trustworthy when the grader could see the material.
        "graded_against_lesson": bool(session and session.lesson),
    }


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
    if req.engine not in ENGINES:
        raise HTTPException(400, f"Unknown engine: {req.engine}")
    if req.mode not in MODES:
        raise HTTPException(400, f"Unknown mode: {req.mode}")
    if req.listening_mode not in {"auto", "manual"}:
        raise HTTPException(400, f"Unknown listening mode: {req.listening_mode}")
    if req.voice_mode not in VOICE_MODES:
        raise HTTPException(400, f"Unknown voice mode: {req.voice_mode}")
    if req.voice not in SPEECH_VOICES:
        raise HTTPException(400, f"Unknown voice: {req.voice}")

    try:
        _, lesson, title = await fetch_lesson(req.lesson_url)
    except LessonError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    # Engine-independent: both paths teach from the same instructions.
    instructions = build_instructions(
        req.mode,
        req.language.strip() or "English",
        lesson,
        difficulty=req.difficulty,
        pace=req.pace,
        memory=req.memory,
    )

    common = {"engine": req.engine, "lesson_title": title, "lesson_chars": len(lesson)}

    if req.engine == "pipeline":
        session_id = sessions.create(
            req.api_key.strip(),
            instructions,
            lesson,
            voice_mode=req.voice_mode,
            voice=req.voice,
        )
        return {
            **common,
            "session_id": session_id,
            "ws": f"/api/pipeline/ws/{session_id}",
            "model": PIPELINE_CHAT_MODEL,
        }

    # Realtime talks to OpenAI directly, so the server needs nothing from it --
    # except the lesson, which the grader checks answers against. The key is
    # deliberately not kept: /api/assess carries its own.
    session_id = sessions.create("", instructions, lesson)

    try:
        client_secret = await mint_client_secret(
            req.api_key.strip(),
            instructions,
            listening_mode=req.listening_mode,
        )
    except RealtimeError as exc:
        raise HTTPException(exc.status, exc.message) from exc

    return {
        **common,
        "client_secret": client_secret,
        "model": REALTIME_MODEL,
        "session_id": session_id,
    }


# --- turn-based engine socket ----------------------------------------------
# Deliberately speaks the Realtime event vocabulary. The browser's transcript,
# session-summary and learner-memory code is shared by both engines and does
# not know which one is connected.


async def _report_usage(websocket: WebSocket, kind: str, model: str, **detail) -> None:
    """Raw usage only. The browser prices it, so Realtime and pipeline spend
    land in the same ticker through the same code."""
    await websocket.send_json({"type": "usage", "kind": kind, "model": model, **detail})


_WIDE_ENDERS = "…。！？"


def _sentence_end(text: str) -> int:
    """Index of the first real sentence end, or -1.

    Mirrors the same function in app.js: skips the dot in "3.5", and waits for
    trailing whitespace so a terminator mid-stream is not cut early.
    """
    for i, ch in enumerate(text):
        if ch in _WIDE_ENDERS:
            return i
        if ch not in ".!?":
            continue
        if (
            ch == "."
            and i
            and text[i - 1].isdigit()
            and i + 1 < len(text)
            and text[i + 1].isdigit()
        ):
            continue
        if i + 1 < len(text) and text[i + 1].isspace():
            return i
    return -1


async def _say(websocket: WebSocket, session: TutorSession, item_id: str, text: str) -> bool:
    """Synthesise one sentence and stream it. False means fall back to the browser."""
    line = text.strip()
    if not line:
        return True

    try:
        audio = await synthesize(session.api_key, line, session.voice or SPEECH_VOICE)
    except SpeechError as exc:
        # Never leave the student in silence: tell the browser to take over
        # with its own voice for the rest of the session.
        session.voice_mode = "browser"
        await websocket.send_json({"type": "speech.failed", "message": exc.message})
        return False

    await websocket.send_json(
        {
            "type": "audio.delta",
            "item_id": item_id,
            "mime": mime_type(),
            "data": base64.b64encode(audio).decode(),
        }
    )
    return True


async def _speak(websocket: WebSocket, session: TutorSession) -> None:
    """Stream one tutor turn to the browser as transcript deltas.

    With the neural voice on, each finished sentence is synthesised as it lands
    rather than waiting for the whole reply -- the student starts hearing the
    answer while the model is still writing the rest of it.
    """
    item_id = uuid.uuid4().hex
    reply: list[str] = []
    unsaid = ""

    async for event in stream_reply(session.api_key, session.messages()):
        if "usage" in event:
            await _report_usage(websocket, "chat", PIPELINE_CHAT_MODEL, usage=event["usage"])
            continue

        delta = event["delta"]
        reply.append(delta)
        await websocket.send_json(
            {
                "type": "response.output_audio_transcript.delta",
                "item_id": item_id,
                "delta": delta,
            }
        )

        if session.voice_mode != "openai":
            continue

        unsaid += delta
        while True:
            cut = _sentence_end(unsaid)
            # Hold a very short sentence back and let it ride with the next one.
            if cut == -1 or cut + 1 < SPEECH_MIN_CHARS:
                break
            if not await _say(websocket, session, item_id, unsaid[: cut + 1]):
                unsaid = ""
                break
            unsaid = unsaid[cut + 1 :]

    if session.voice_mode == "openai" and unsaid.strip():
        await _say(websocket, session, item_id, unsaid)

    session.add("assistant", "".join(reply))
    await websocket.send_json({"type": "response.done", "item_id": item_id})


@app.websocket("/api/pipeline/ws/{session_id}")
async def pipeline_ws(websocket: WebSocket, session_id: str):
    await websocket.accept()

    session = sessions.get(session_id)
    if session is None:
        await websocket.send_json(
            {"type": "error", "error": {"message": "Session expired. Press Start again."}}
        )
        await websocket.close()
        return

    try:
        # The instructions end with "Open the session now", so the first turn
        # needs no student input.
        await _speak(websocket, session)

        while True:
            message = await websocket.receive_json()
            if message.get("type") != "utterance":
                continue

            try:
                audio = base64.b64decode(message.get("data") or "")
            except Exception:
                await websocket.send_json(
                    {"type": "error", "error": {"message": "Malformed audio frame."}}
                )
                continue

            said, stt_usage = await transcribe(
                session.api_key, audio, message.get("mime") or "audio/webm"
            )
            # Send both: whatever the API reported, and the clip length the
            # browser measured. The ticker prefers the former and falls back to
            # the latter, so it can say which one produced the figure.
            await _report_usage(
                websocket,
                "stt",
                PIPELINE_TRANSCRIPTION_MODEL,
                usage=stt_usage,
                seconds=float(message.get("seconds") or 0),
            )
            if not said:
                # Silence or background noise. Costs one cheap STT call and
                # saves a pointless completion.
                await websocket.send_json({"type": "response.skipped"})
                continue

            await websocket.send_json(
                {
                    "type": "conversation.item.input_audio_transcription.completed",
                    "item_id": uuid.uuid4().hex,
                    "transcript": said,
                }
            )
            session.add("user", said)
            await _speak(websocket, session)

    except WebSocketDisconnect:
        pass
    except PipelineError as exc:
        try:
            await websocket.send_json({"type": "error", "error": {"message": exc.message}})
        except Exception:
            pass
    finally:
        # The session holds the student's API key; do not outlive the socket.
        sessions.drop(session_id)


# Mounted last so the /api routes above win. html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
