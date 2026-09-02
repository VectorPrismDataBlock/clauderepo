"""Grades one student answer so the proficiency gauge has something real behind it.

This is deliberately a separate, small call rather than something bolted onto
the tutor's own turn. Two reasons: it stays off the latency path (the student
is already hearing the reply while this runs), and it works identically for
both engines, where in-band tricks would not -- the Realtime model speaks every
token it produces, so it cannot emit a hidden tag.

The prompt carries the lesson itself. An earlier version sent only the title to
save tokens, and the grader -- with nothing to check an answer against --
returned "partial" for everything, which pinned the proficiency gauge at exactly
50% forever. The lesson now sits in the system message where it is a stable
prefix, so prompt caching absorbs most of the cost of having it there.
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
You grade one exchange from a spoken tutoring session, against the lesson below.

RUBRIC
- "correct": the answer says something the lesson supports, even loosely worded.
- "incorrect": the answer contradicts the lesson, or is a confident guess the
  lesson does not support.
- "partial": genuinely half right -- one of two required ideas, or the right
  idea with a wrong detail attached.
- "off_topic": a question back, a request to repeat, silence, or chit-chat.

Do not use "partial" as a hedge. If the lesson lets you decide, decide. A short
or plainly worded answer that gets the idea right is "correct", not "partial".

The answer arrived via speech-to-text, so ignore transcription noise, spelling,
punctuation and filler words. Judge the idea, not the phrasing. Name the concept
in 1-4 words using the lesson's own vocabulary. The session runs in {language}.

LESSON: {title}
=====
{lesson}
====="""


# Used when no lesson is on hand -- an expired session, or a direct API call.
# Deliberately more cautious, because without the material there is no ground
# truth to grade against.
BLIND_PROMPT = """\
You grade one exchange from a spoken tutoring session on "{title}".

The lesson text is not available, so judge only what you can: whether the answer
is coherent and on topic. Use "correct" only when the answer is plainly right on
general knowledge, "off_topic" for a question back or chit-chat, and "partial"
when you genuinely cannot tell. The session runs in {language}."""


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
    lesson: str = "",
) -> tuple[dict, dict]:
    """Return (assessment, usage). Usage feeds the cost ticker like any other call."""
    # The lesson goes in the system message and never changes during a
    # session, so it is a stable prefix and hits the prompt cache from the
    # second graded answer onwards. That is what keeps this affordable.
    if lesson.strip():
        system = PROMPT.format(
            title=title or "this lesson", language=language, lesson=lesson
        )
    else:
        system = BLIND_PROMPT.format(
            title=title or "this lesson", language=language
        )

    payload = {
        "model": ASSESS_MODEL,
        "messages": [
            {"role": "system", "content": system},
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
