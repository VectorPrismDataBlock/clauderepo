import asyncio
import json
import unittest
from unittest.mock import patch

from app.pipeline import _extension, stream_reply, transcribe
from app.session import SessionStore, TutorSession


def run(coro):
    return asyncio.run(coro)


async def collect(agen):
    return [chunk async for chunk in agen]


class FakeResponse:
    def __init__(self, payload=None, lines=None, is_error=False, status_code=200):
        self._payload = payload or {}
        self._lines = lines or []
        self.is_error = is_error
        self.status_code = status_code
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload

    async def aread(self):
        return b""

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class FakeStream:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *exc):
        return False


class FakeClient:
    """Stands in for httpx.AsyncClient. Set `response` before use."""

    response = None
    last_kwargs = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, *args, **kwargs):
        type(self).last_kwargs = kwargs
        return type(self).response

    def stream(self, *args, **kwargs):
        type(self).last_kwargs = kwargs
        return FakeStream(type(self).response)


USAGE = {"prompt_tokens": 900, "completion_tokens": 12,
         "prompt_tokens_details": {"cached_tokens": 768}}


def sse(*deltas, usage=None):
    lines = [
        "data: " + json.dumps({"choices": [{"delta": {"content": d}}]}) for d in deltas
    ]
    tail = ["data: " + json.dumps({"choices": [], "usage": usage})] if usage else []
    # A keepalive blank line and the terminator, exactly as the API sends them.
    return [lines[0], ""] + lines[1:] + tail + ["data: [DONE]"]


class TranscribeTests(unittest.TestCase):
    def test_returns_stripped_text_and_names_the_file_by_mime(self):
        FakeClient.response = FakeResponse({"text": "  photosynthesis  "})
        with patch("app.pipeline.httpx.AsyncClient", FakeClient):
            said = run(transcribe("k", b"audio", "audio/mp4;codecs=opus"))

        self.assertEqual(said, "photosynthesis")
        self.assertEqual(FakeClient.last_kwargs["files"]["file"][0], "turn.mp4")

    def test_silence_transcribes_to_empty_string(self):
        FakeClient.response = FakeResponse({"text": "   "})
        with patch("app.pipeline.httpx.AsyncClient", FakeClient):
            self.assertEqual(run(transcribe("k", b"", "audio/webm")), "")

    def test_unknown_mime_falls_back_to_webm(self):
        self.assertEqual(_extension("audio/weird"), "webm")


class StreamReplyTests(unittest.TestCase):
    def test_yields_content_deltas_and_ignores_keepalives(self):
        FakeClient.response = FakeResponse(lines=sse("Hel", "lo."))
        with patch("app.pipeline.httpx.AsyncClient", FakeClient):
            chunks = run(collect(stream_reply("k", [{"role": "system", "content": "s"}])))

        self.assertEqual(chunks, [{"delta": "Hel"}, {"delta": "lo."}])
        self.assertTrue(FakeClient.last_kwargs["json"]["stream"])

    def test_asks_for_usage_and_yields_it_last_for_the_cost_ticker(self):
        FakeClient.response = FakeResponse(lines=sse("Hi", ".", usage=USAGE))
        with patch("app.pipeline.httpx.AsyncClient", FakeClient):
            chunks = run(collect(stream_reply("k", [{"role": "system", "content": "s"}])))

        self.assertTrue(FakeClient.last_kwargs["json"]["stream_options"]["include_usage"])
        self.assertEqual(chunks[-1], {"usage": USAGE})
        self.assertEqual([c["delta"] for c in chunks[:-1]], ["Hi", "."])


class SessionTests(unittest.TestCase):
    def test_system_prompt_stays_first_and_unchanged(self):
        session = TutorSession(api_key="k", instructions="LESSON TEXT")
        session.add("user", "hi")
        session.add("assistant", "hello")

        messages = session.messages()
        self.assertEqual(messages[0], {"role": "system", "content": "LESSON TEXT"})
        self.assertEqual([m["role"] for m in messages[1:]], ["user", "assistant"])

    def test_history_is_capped_but_the_lesson_survives(self):
        session = TutorSession(api_key="k", instructions="LESSON TEXT")
        for i in range(40):
            session.add("user", f"q{i}")
            session.add("assistant", f"a{i}")

        messages = session.messages()
        self.assertEqual(messages[0]["content"], "LESSON TEXT")
        self.assertEqual(len(messages), 21)  # system + PIPELINE_HISTORY_TURNS * 2
        self.assertEqual(messages[-1]["content"], "a39")

    def test_dropping_a_session_forgets_the_api_key(self):
        store = SessionStore()
        session_id = store.create("sk-secret", "instructions")
        self.assertIsNotNone(store.get(session_id))
        store.drop(session_id)
        self.assertIsNone(store.get(session_id))


if __name__ == "__main__":
    unittest.main()
