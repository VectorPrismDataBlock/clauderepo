"""The low-cost engine: speech-to-text, a text completion, then browser speech.

Realtime charges audio tokens going in *and* coming out. Here the model only
ever sees text: we transcribe the student's utterance (billed per minute of
audio, not per token), send text to a small chat model, and stream the reply
back as text for the browser's own synthesiser to speak for free. Nothing about
the tutor's behaviour changes -- `build_instructions` produces the same system
prompt either way.

The trade is duplex. Each turn is a round trip, so the student and the tutor
take strict turns and there is no interrupting mid-sentence.
"""

import json
from typing import AsyncIterator

import httpx

from .config import (
    CHAT_URL,
    PIPELINE_CHAT_MODEL,
    PIPELINE_MAX_TOKENS,
    PIPELINE_TRANSCRIPTION_MODEL,
    TRANSCRIPTIONS_URL,
)


class PipelineError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# MediaRecorder picks whatever the browser supports, so we map its mime type to
# the file extension the transcription endpoint sniffs on.
_EXTENSIONS = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}


def _extension(mime: str) -> str:
    return _EXTENSIONS.get(mime.split(";")[0].strip().lower(), "webm")


def _detail(response: httpx.Response, fallback: str) -> str:
    """OpenAI's own error message explains bad keys, quota and bad models."""
    try:
        return response.json()["error"]["message"]
    except Exception:
        return response.text or fallback


async def transcribe(api_key: str, audio: bytes, mime: str) -> str:
    """Return what the student said, or "" if the clip held no speech."""
    files = {"file": (f"turn.{_extension(mime)}", audio, mime)}

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(
                TRANSCRIPTIONS_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data={"model": PIPELINE_TRANSCRIPTION_MODEL},
            )
        except httpx.RequestError as exc:
            raise PipelineError(502, f"Could not reach OpenAI: {exc}") from exc

    if response.is_error:
        raise PipelineError(response.status_code, _detail(response, "Transcription failed"))

    return (response.json().get("text") or "").strip()


async def stream_reply(api_key: str, messages: list[dict]) -> AsyncIterator[dict]:
    """Yield `{"delta": text}` events, then one `{"usage": {...}}` at the end.

    Streaming is what makes the latency tolerable: the browser starts speaking
    the first sentence while the rest is still being written. The trailing
    usage chunk is what the cost ticker is built on -- it reports real token
    counts, including how many were served from the prompt cache.
    """
    payload = {
        "model": PIPELINE_CHAT_MODEL,
        "messages": messages,
        "max_completion_tokens": PIPELINE_MAX_TOKENS,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # Generous read timeout: the first token can be slow, later ones are not.
    timeout = httpx.Timeout(60.0, connect=10.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream("POST", CHAT_URL, headers=headers, json=payload) as response:
                if response.is_error:
                    await response.aread()
                    raise PipelineError(
                        response.status_code, _detail(response, "Chat completion failed")
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    # The usage chunk arrives last and carries no choices.
                    if chunk.get("usage"):
                        yield {"usage": chunk["usage"]}
                    for choice in chunk.get("choices") or []:
                        delta = (choice.get("delta") or {}).get("content")
                        if delta:
                            yield {"delta": delta}
        except httpx.RequestError as exc:
            raise PipelineError(502, f"Could not reach OpenAI: {exc}") from exc
