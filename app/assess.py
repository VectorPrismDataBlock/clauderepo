"""Grades one student answer so the proficiency gauge has something real behind it.

This is deliberately a separate, small call rather than something bolted onto
the tutor's own turn. Two reasons: it stays off the latency path (the student
is already hearing the reply while this runs), and it works identically for
both engines, where in-band tricks would not -- the Realtime model speaks every
token it produces, so it cannot emit a hidden tag.

The prompt carries the lesson title and the exchange, never the lesson body.
That is what keeps a graded turn to a fraction of a cent.
"""

import json

import httpx

from .config import ASSESS_MAX_TOKENS, ASSESS_MODEL, CHAT_URL

SCHEMA = {
    "type": "object",
    "properties": {
        "concept": {
            "type": "string",
            "description": "The single idea being tested, 1-4 words, from the lesson's own vocabulary.",
        },
        "verdict": {
            "type": "string",
            "enum": ["correct", "partial", "incorrect", "off_topic"],
        },
        "note": {
            "type": "string",
            "description": "One short clause on what the answer showed. No praise, no advice.",
        },
    },
    "required": ["concept", "verdict", "note"],
    "additionalProperties": False,
}

PROMPT = """\
You grade one exchange from a spoken tutoring session on "{title}".

Judge only whether the student's answer is right about the concept the tutor \
asked about. Be strict but fair: a vague answer that shows the right idea is \
"partial"; a confident answer that is wrong is "incorrect"; a question back, a \
request to repeat, or chit-chat is "off_topic".

The answer arrived via speech-to-text, so ignore transcription noise, \
punctuation and filler words. The session runs in {language}."""


class AssessError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def assess(
    api_key: str,
    title: str,
    question: str,
    answer: str,
    language: str = "English",
) -> tuple[dict, dict]:
    """Return (assessment, usage). Usage feeds the cost ticker like any other call."""
    payload = {
        "model": ASSESS_MODEL,
        "messages": [
            {"role": "system", "content": PROMPT.format(title=title or "this lesson", language=language)},
            {"role": "user", "content": f"TUTOR ASKED:\n{question}\n\nSTUDENT ANSWERED:\n{answer}"},
        ],
        "max_completion_tokens": ASSESS_MAX_TOKENS,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "assessment", "strict": True, "schema": SCHEMA},
        },
    }

    async with httpx.AsyncClient(timeout=30) as client:
        try:
            response = await client.post(
                CHAT_URL,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
        except httpx.RequestError as exc:
            raise AssessError(502, f"Could not reach OpenAI: {exc}") from exc

    if response.is_error:
        try:
            detail = response.json()["error"]["message"]
        except Exception:
            detail = response.text or "Assessment failed"
        raise AssessError(response.status_code, detail)

    body = response.json()
    try:
        assessment = json.loads(body["choices"][0]["message"]["content"])
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise AssessError(502, "Assessment came back unreadable") from exc

    return assessment, body.get("usage") or {}
