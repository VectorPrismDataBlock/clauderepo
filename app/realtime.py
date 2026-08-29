"""Mints an ephemeral Realtime client secret using the student's own API key.

The raw API key never reaches OpenAI from the browser: the browser sends it
here, we exchange it for a short-lived `ek_...` secret, and only that goes back
to the client for the SDP handshake.
"""

import httpx

from .config import (
    CLIENT_SECRETS_URL,
    DEFAULT_VOICE,
    INPUT_TRANSCRIPTION_MODEL,
    REALTIME_MODEL,
    TURN_DETECTION,
)


class RealtimeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def mint_client_secret(api_key: str, instructions: str, voice: str = DEFAULT_VOICE) -> str:
    """Return the ephemeral key string for a configured tutor session."""
    payload = {
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "instructions": instructions,
            "audio": {
                "input": {
                    "transcription": {"model": INPUT_TRANSCRIPTION_MODEL},
                    "turn_detection": TURN_DETECTION,
                },
                "output": {"voice": voice},
            },
        }
    }

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(
                CLIENT_SECRETS_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        except httpx.RequestError as exc:
            raise RealtimeError(502, f"Could not reach OpenAI: {exc}") from exc

    if response.is_error:
        # Surface OpenAI's own message — it explains bad keys, quota, bad model.
        detail = response.text
        try:
            detail = response.json()["error"]["message"]
        except Exception:
            pass
        raise RealtimeError(response.status_code, detail)

    return response.json()["value"]
