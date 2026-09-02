"""Cover for the optional neural tutor voice."""

import base64
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import SPEECH_MIN_CHARS, SPEECH_MODEL, PRICING
from app.main import _sentence_end, app
from app.session import sessions
from app.speech import SpeechError

LESSON = ("<html/>", "Cells make energy in the mitochondria.", "Cell Biology")

# Two sentences, both comfortably past SPEECH_MIN_CHARS.
REPLY = ["Photosynthesis turns light into chemical energy. ",
         "Now, where in the leaf does that happen?"]


async def fake_fetch_lesson(url):
    return LESSON


async def fake_stream_reply(api_key, messages):
    for delta in REPLY:
        yield {"delta": delta}


def body(**over):
    base = {"api_key": "sk-x", "lesson_url": "https://e.com/x", "engine": "pipeline"}
    base.update(over)
    return base


class SentenceSplitTests(unittest.TestCase):
    """Must agree with sentenceEnd() in app.js or the two voices diverge."""

    def test_splits_on_a_terminator_followed_by_space(self):
        self.assertEqual(_sentence_end("One. Two"), 3)

    def test_waits_for_more_text_rather_than_cutting_at_the_end(self):
        self.assertEqual(_sentence_end("Not yet."), -1)

    def test_does_not_split_a_decimal(self):
        self.assertEqual(_sentence_end("It is 3.5 metres"), -1)

    def test_cjk_terminators_need_no_trailing_space(self):
        self.assertEqual(_sentence_end("これ。次"), 2)


class VoiceRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_voices_are_listed_for_the_dropdown(self):
        data = self.client.get("/api/voices").json()
        self.assertEqual([m["id"] for m in data["modes"]], ["browser", "openai"])
        self.assertIn(data["default_voice"], data["openai_voices"])

    def test_the_speech_model_has_a_rate_so_the_ticker_can_price_it(self):
        models = self.client.get("/api/pricing").json()["models"]
        self.assertEqual(models["speech"], SPEECH_MODEL)
        self.assertIn("per_minute", PRICING[SPEECH_MODEL])

    def test_an_unknown_voice_is_rejected(self):
        self.assertEqual(
            self.client.post("/api/session", json=body(voice="kermit")).status_code, 400)

    def test_the_voice_choice_reaches_the_session(self):
        with patch("app.main.fetch_lesson", fake_fetch_lesson):
            data = self.client.post(
                "/api/session", json=body(voice_mode="openai", voice="sage")).json()

        held = sessions.get(data["session_id"])
        self.assertEqual(held.voice_mode, "openai")
        self.assertEqual(held.voice, "sage")


class SpokenTurnTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def open_socket(self, **over):
        with patch("app.main.fetch_lesson", fake_fetch_lesson):
            data = self.client.post("/api/session", json=body(**over)).json()
        return data["session_id"]

    def drain(self, socket):
        events = []
        while True:
            event = socket.receive_json()
            events.append(event)
            if event["type"] == "response.done":
                return events

    def test_browser_mode_sends_no_audio_at_all(self):
        session_id = self.open_socket(voice_mode="browser")
        with patch("app.main.stream_reply", fake_stream_reply), \
             patch("app.main.synthesize") as spoke:
            with self.client.websocket_connect(f"/api/pipeline/ws/{session_id}") as socket:
                events = self.drain(socket)

        spoke.assert_not_called()
        self.assertEqual([e for e in events if e["type"] == "audio.delta"], [])

    def test_each_finished_sentence_is_spoken_as_it_lands(self):
        said = []

        async def fake_synth(api_key, text, voice):
            said.append(text)
            return b"MP3" + text.encode()

        session_id = self.open_socket(voice_mode="openai", voice="coral")
        with patch("app.main.stream_reply", fake_stream_reply), \
             patch("app.main.synthesize", fake_synth):
            with self.client.websocket_connect(f"/api/pipeline/ws/{session_id}") as socket:
                events = self.drain(socket)

        # One call per sentence, not one for the whole reply -- that is what
        # lets the student hear sentence one while two is still being written.
        self.assertEqual(len(said), 2)
        self.assertTrue(said[0].startswith("Photosynthesis"))
        self.assertTrue(all(len(s.strip()) >= SPEECH_MIN_CHARS for s in said))

        audio = [e for e in events if e["type"] == "audio.delta"]
        self.assertEqual(len(audio), 2)
        self.assertEqual(audio[0]["mime"], "audio/mpeg")
        self.assertTrue(base64.b64decode(audio[0]["data"]).startswith(b"MP3"))

        # Transcript still streams for both voices.
        deltas = [e for e in events if e["type"] == "response.output_audio_transcript.delta"]
        self.assertEqual("".join(d["delta"] for d in deltas), "".join(REPLY))

    def test_a_failed_synthesis_hands_the_turn_to_the_browser(self):
        async def boom(api_key, text, voice):
            raise SpeechError(429, "rate limited")

        session_id = self.open_socket(voice_mode="openai")
        with patch("app.main.stream_reply", fake_stream_reply), \
             patch("app.main.synthesize", boom):
            with self.client.websocket_connect(f"/api/pipeline/ws/{session_id}") as socket:
                events = self.drain(socket)
                # Read it before the socket closes; that drops the session.
                mode_after = sessions.get(session_id).voice_mode

        failed = [e for e in events if e["type"] == "speech.failed"]
        self.assertEqual(len(failed), 1)          # told once, then stops trying
        self.assertIn("rate limited", failed[0]["message"])
        self.assertEqual(mode_after, "browser")


if __name__ == "__main__":
    unittest.main()
