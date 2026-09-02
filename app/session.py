"""Server-side conversation state for the turn-based engine.

Realtime keeps the conversation for us and hands the browser a short-lived
`ek_...` secret, so the raw key is never held anywhere. The pipeline cannot do
that: it calls OpenAI on every single turn, so it has to keep the student's key
in memory for the life of the session. That is the one place where the cheap
engine is weaker than the expensive one, and it is why sessions expire.

In-process and single-worker by design -- this is a prototype. Run more than one
uvicorn worker and a session will land on a worker that has never heard of it.
"""

import time
import uuid
from dataclasses import dataclass, field

from .config import PIPELINE_HISTORY_TURNS, SESSION_TTL_SECONDS


@dataclass
class TutorSession:
    api_key: str
    instructions: str
    # Kept so the grader can check an answer against the material. Without it
    # a grader has no ground truth and hedges every verdict to "partial".
    lesson: str = ""
    # "browser" (free, the student's own machine speaks) or "openai" (a neural
    # voice, synthesised a sentence at a time and billed per minute).
    voice_mode: str = "browser"
    voice: str = ""
    created: float = field(default_factory=time.monotonic)
    # Dialogue only. The system message is rebuilt from `instructions` on every
    # request so it stays byte-identical and keeps hitting the prompt cache.
    history: list[dict] = field(default_factory=list)

    def messages(self) -> list[dict]:
        return [{"role": "system", "content": self.instructions}, *self.history]

    def add(self, role: str, content: str) -> None:
        self.history.append({"role": role, "content": content})
        # Drop the oldest exchanges rather than resending the whole session.
        # The lesson lives in the system prompt, so nothing essential is lost.
        limit = PIPELINE_HISTORY_TURNS * 2
        if len(self.history) > limit:
            del self.history[: len(self.history) - limit]


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, TutorSession] = {}

    def create(self, api_key: str, instructions: str, lesson: str = "", **fields) -> str:
        self._reap()
        session_id = uuid.uuid4().hex
        self._sessions[session_id] = TutorSession(
            api_key=api_key, instructions=instructions, lesson=lesson, **fields
        )
        return session_id

    def get(self, session_id: str) -> TutorSession | None:
        self._reap()
        return self._sessions.get(session_id)

    def drop(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def _reap(self) -> None:
        cutoff = time.monotonic() - SESSION_TTL_SECONDS
        for session_id in [k for k, v in self._sessions.items() if v.created < cutoff]:
            del self._sessions[session_id]


sessions = SessionStore()
