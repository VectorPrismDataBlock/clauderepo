"""Optional neural voice for the turn-based engine.

The default tutor voice is the browser's own synthesiser: free, offline, and on
a machine with only old SAPI voices installed, robotic. This is the opt-in
alternative -- a real TTS call per sentence, billed per minute of audio.

It is done a sentence at a time on purpose. Synthesising the whole reply would
mean the student hears nothing until the model has finished writing, which is
the latency the turn-based engine can least afford. One sentence is enough to
start talking over.
"""

import httpx

from .config import SPEECH_FORMAT, SPEECH_INSTRUCTIONS, SPEECH_MODEL, SPEECH_URL, SPEECH_VOICE

MIME = {"mp3": "audio/mpeg", "opus": "audio/ogg", "aac": "audio/aac",
        "flac": "audio/flac", "wav": "audio/wav", "pcm": "audio/pcm"}


class SpeechError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def mime_type() -> str:
    return MIME.get(SPEECH_FORMAT, "audio/mpeg")


async def synthesize(api_key: str, text: str, voice: str = SPEECH_VOICE) -> bytes:
    """Speak one sentence. Returns the encoded audio.

    The endpoint returns audio bytes and no usage block, so the caller prices
    this from the audio's own duration -- see `_report_usage` in main.py.
    """
    payload = {
        "model": SPEECH_MODEL,
        "voice": voice,
        "input": text,
        "response_format": SPEECH_FORMAT,
        # Only gpt-4o-mini-tts honours this; tts-1 ignores it harmlessly.
        "instructions": SPEECH_INSTRUCTIONS,
    }

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            response = await client.post(
                SPEECH_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
        except httpx.RequestError as exc:
            raise SpeechError(502, f"Could not reach OpenAI: {exc}") from exc

    if response.is_error:
        detail = response.text
        try:
            detail = response.json()["error"]["message"]
        except Exception:
            pass
        raise SpeechError(response.status_code, detail)

    return response.content
