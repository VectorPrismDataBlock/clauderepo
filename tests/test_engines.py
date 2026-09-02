"""End-to-end cover for the engine split: same routes, two transports."""

import base64
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.session import sessions

LESSON = ("<html/>", "Cells make energy in the mitochondria.", "Cell Biology")


async def fake_fetch_lesson(url):
    return LESSON


REPLY_USAGE = {"prompt_tokens": 1200, "completion_tokens": 9,
               "prompt_tokens_details": {"cached_tokens": 1024}}


async def fake_stream_reply(api_key, messages):
    for delta in ["Let's start. ", "What is a cell?"]:
        yield {"delta": delta}
    yield {"usage": REPLY_USAGE}


STT_USAGE = {"type": "tokens", "input_tokens": 190,
             "input_token_details": {"audio_tokens": 176}}


async def fake_transcribe(api_key, audio, mime):
    # The client sends a one-byte clip to mean "this held no speech".
    said = "" if audio == b"\x00" else "The mitochondria."
    return said, STT_USAGE


def utterance(data: bytes, seconds: float = 3.0):
    return {
        "type": "utterance",
        "mime": "audio/webm",
        "seconds": seconds,
        "data": base64.b64encode(data).decode(),
    }


def session_body(engine):
    return {"api_key": "sk-test", "lesson_url": "https://example.com/x", "engine": engine}


class EngineSelectionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_engines_are_listed_for_the_dropdown(self):
        ids = [e["id"] for e in self.client.get("/api/engines").json()]
        self.assertEqual(ids, ["realtime", "pipeline"])

    def test_unknown_engine_is_rejected(self):
        response = self.client.post("/api/session", json=session_body("carrier-pigeon"))
        self.assertEqual(response.status_code, 400)

    def test_realtime_still_mints_an_ephemeral_secret(self):
        with patch("app.main.fetch_lesson", fake_fetch_lesson), \
             patch("app.main.mint_client_secret", return_value="ek_123") as mint:
            data = self.client.post("/api/session", json=session_body("realtime")).json()

        mint.assert_awaited_once()
        self.assertEqual(data["engine"], "realtime")
        self.assertEqual(data["client_secret"], "ek_123")

        # Realtime gets a server session too, but only to hold the lesson for
        # the grader. The key is deliberately not kept -- /api/assess brings
        # its own on every call.
        held = sessions.get(data["session_id"])
        self.assertEqual(held.api_key, "")
        self.assertIn("mitochondria", held.lesson)

    def test_pipeline_creates_a_session_without_calling_openai(self):
        with patch("app.main.fetch_lesson", fake_fetch_lesson), \
             patch("app.main.mint_client_secret") as mint:
            data = self.client.post("/api/session", json=session_body("pipeline")).json()

        mint.assert_not_called()
        self.assertEqual(data["engine"], "pipeline")
        self.assertEqual(data["ws"], f"/api/pipeline/ws/{data['session_id']}")
        self.assertEqual(data["lesson_title"], "Cell Biology")

        # The lesson is baked into the system prompt the socket will replay,
        # and kept verbatim so the grader can check answers against it.
        held = sessions.get(data["session_id"])
        self.assertIn("mitochondria", held.instructions)
        self.assertIn("mitochondria", held.lesson)
        self.assertEqual(held.api_key, "sk-test")


class PipelineSocketTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.usage = []
        with patch("app.main.fetch_lesson", fake_fetch_lesson):
            self.session_id = self.client.post(
                "/api/session", json=session_body("pipeline")
            ).json()["session_id"]

    def next_event(self, socket):
        """Next event that isn't a usage report; usage is banked for the ticker."""
        while True:
            event = socket.receive_json()
            if event["type"] != "usage":
                return event
            self.usage.append(event)

    def drain_turn(self, socket):
        """Collect one tutor turn's deltas, up to response.done."""
        deltas = []
        while True:
            event = self.next_event(socket)
            if event["type"] == "response.done":
                return "".join(deltas), event
            if event["type"] == "response.output_audio_transcript.delta":
                deltas.append(event["delta"])

    def test_a_full_turn_speaks_the_realtime_event_vocabulary(self):
        with patch("app.main.stream_reply", fake_stream_reply), \
             patch("app.main.transcribe", fake_transcribe):
            with self.client.websocket_connect(f"/api/pipeline/ws/{self.session_id}") as socket:
                greeting, _ = self.drain_turn(socket)
                self.assertEqual(greeting, "Let's start. What is a cell?")

                socket.send_json(utterance(b"spoken-audio", seconds=4.5))
                heard = self.next_event(socket)
                self.assertEqual(
                    heard["type"], "conversation.item.input_audio_transcription.completed"
                )
                self.assertEqual(heard["transcript"], "The mitochondria.")

                reply, done = self.drain_turn(socket)
                self.assertEqual(reply, "Let's start. What is a cell?")
                self.assertTrue(done["item_id"])

        # Both cost legs reported raw, for the browser to price.
        stt = [u for u in self.usage if u["kind"] == "stt"]
        chat = [u for u in self.usage if u["kind"] == "chat"]
        self.assertEqual(stt[0]["seconds"], 4.5)
        # Reported usage rides along so the ticker prefers it over our clock.
        self.assertEqual(stt[0]["usage"], STT_USAGE)
        self.assertEqual(chat[0]["usage"], REPLY_USAGE)

    def test_silence_is_skipped_instead_of_billed_as_a_completion(self):
        calls = []

        async def counting_stream(api_key, messages):
            calls.append(messages)
            yield {"delta": "hi"}

        with patch("app.main.stream_reply", counting_stream), \
             patch("app.main.transcribe", fake_transcribe):
            with self.client.websocket_connect(f"/api/pipeline/ws/{self.session_id}") as socket:
                self.drain_turn(socket)  # greeting
                socket.send_json(utterance(b"\x00", seconds=2.0))
                self.assertEqual(self.next_event(socket)["type"], "response.skipped")

        self.assertEqual(len(calls), 1)  # the greeting only

        # Silence is still transcribed, so the ticker hears about that much.
        kinds = [u["kind"] for u in self.usage]
        self.assertIn("stt", kinds)

    def test_closing_the_socket_forgets_the_session_and_its_key(self):
        with patch("app.main.stream_reply", fake_stream_reply), \
             patch("app.main.transcribe", fake_transcribe):
            with self.client.websocket_connect(f"/api/pipeline/ws/{self.session_id}") as socket:
                self.drain_turn(socket)

        self.assertIsNone(sessions.get(self.session_id))

    def test_an_expired_session_reports_instead_of_hanging(self):
        sessions.drop(self.session_id)
        with self.client.websocket_connect(f"/api/pipeline/ws/{self.session_id}") as socket:
            event = socket.receive_json()

        self.assertEqual(event["type"], "error")
        self.assertIn("expired", event["error"]["message"])


if __name__ == "__main__":
    unittest.main()
