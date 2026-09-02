"""Cover for the proficiency grader and the cost-ticker rate table."""

import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.assess import AssessError, assess
from app.config import PRICING, VERDICT_SCORES
from app.main import app


async def fake_fetch_lesson(url):
    return ("<html/>", "Cells make energy in the mitochondria.", "Cell Biology")

GRADED = {"concept": "photosynthesis", "verdict": "partial", "note": "Named the inputs only."}


class FakeResponse:
    is_error = False
    status_code = 200

    def __init__(self, content, usage=None):
        self._body = {
            "choices": [{"message": {"content": content}}],
            "usage": usage or {"prompt_tokens": 210, "completion_tokens": 28},
        }
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeClient:
    response = None
    last_json = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, *args, **kwargs):
        type(self).last_json = kwargs["json"]
        return type(self).response


class AssessTests(unittest.TestCase):
    def test_returns_the_verdict_and_the_usage_that_feeds_the_ticker(self):
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            assessment, usage = asyncio.run(
                assess("k", "Cell Biology", "What is a chloroplast?", "The green bit.")
            )

        self.assertEqual(assessment, GRADED)
        self.assertEqual(usage["prompt_tokens"], 210)

    def test_the_lesson_is_sent_so_the_grader_has_ground_truth(self):
        """Regression: grading against only a title made every verdict
        "partial", which pinned the gauge at exactly 50% forever."""
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            asyncio.run(assess("k", "Cell Biology", "Q?", "A.",
                               lesson="Chloroplasts capture light energy."))

        system = FakeClient.last_json["messages"][0]["content"]
        self.assertIn("Chloroplasts capture light energy.", system)
        self.assertIn("Cell Biology", system)
        # And the rubric must actively forbid the hedge.
        self.assertIn("Do not use \"partial\" as a hedge", system)

    def test_the_lesson_leads_the_prompt_so_it_can_be_cached(self):
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            asyncio.run(assess("k", "T", "Q?", "A.", lesson="BODY TEXT"))

        messages = FakeClient.last_json["messages"]
        # Lesson in the system message (stable prefix), exchange in the user
        # message (the only part that varies per turn).
        self.assertIn("BODY TEXT", messages[0]["content"])
        self.assertNotIn("BODY TEXT", messages[1]["content"])
        self.assertIn("Q?", messages[1]["content"])

    def test_without_a_lesson_it_falls_back_and_says_it_is_blind(self):
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            asyncio.run(assess("k", "T", "Q?", "A."))

        system = FakeClient.last_json["messages"][0]["content"]
        self.assertIn("lesson text is not available", system)

    def test_strict_json_keeps_the_gauge_safe_to_drive(self):
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            asyncio.run(assess("k", "T", "Q?", "A.", lesson="x"))
        self.assertTrue(FakeClient.last_json["response_format"]["json_schema"]["strict"])

    def test_unreadable_output_raises_rather_than_scoring_garbage(self):
        FakeClient.response = FakeResponse("not json at all")
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            with self.assertRaises(AssessError):
                asyncio.run(assess("k", "T", "Q", "A"))


class PricingRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_every_billable_model_has_a_rate_on_file(self):
        data = self.client.get("/api/pricing").json()
        for role, model in data["models"].items():
            self.assertIn(model, data["rates"], f"no rate for {role} ({model})")

    def test_rates_and_scores_come_from_config(self):
        data = self.client.get("/api/pricing").json()
        self.assertEqual(data["rates"], PRICING)
        self.assertEqual(data["verdict_scores"], VERDICT_SCORES)
        self.assertNotIn("off_topic", data["verdict_scores"])  # scores nothing

    def test_budgets_are_per_engine_and_far_apart(self):
        """A Realtime-sized budget leaves the pipeline meter pinned at zero all
        session, which reads as a broken dial rather than a cheap one."""
        budgets = self.client.get("/api/pricing").json()["default_budget_usd"]
        self.assertEqual(set(budgets), {"realtime", "pipeline"})
        self.assertGreater(budgets["realtime"], budgets["pipeline"] * 10)

    def test_a_turn_moves_the_meter_a_visible_amount_on_both_engines(self):
        """Regression: the dial looked dead because one turn was ~0.1% of budget."""
        data = self.client.get("/api/pricing").json()
        rates, budgets = data["rates"], data["default_budget_usd"]

        rt = rates[data["models"]["realtime"]]
        realtime_turn = (400 * rt["text_input"] + 500 * rt["audio_input"]
                         + 60 * rt["text_output"] + 240 * rt["audio_output"]) / 1e6

        chat = rates[data["models"]["pipeline_chat"]]
        stt = rates[data["models"]["pipeline_stt"]]
        pipeline_turn = ((1200 * chat["text_input"] + 40 * chat["text_output"]) / 1e6
                         + 180 * stt["audio_input"] / 1e6)

        for engine, turn in (("realtime", realtime_turn), ("pipeline", pipeline_turn)):
            share = turn / budgets[engine]
            self.assertGreater(share, 0.01, f"{engine} turn is invisible on the meter")
            self.assertLess(share, 0.2, f"{engine} budget is exhausted in a few turns")

    def test_the_route_hands_the_grader_the_lesson_it_stored(self):
        with patch("app.main.fetch_lesson", fake_fetch_lesson):
            created = self.client.post("/api/session", json={
                "api_key": "sk-x", "lesson_url": "https://e.com/x", "engine": "pipeline"}).json()

        seen = {}

        async def fake(api_key, title, question, answer, language, lesson=""):
            seen["lesson"] = lesson
            return GRADED, {}

        with patch("app.main.assess", fake):
            data = self.client.post("/api/assess", json={
                "api_key": "sk-x", "question": "Q?", "answer": "A.",
                "session_id": created["session_id"]}).json()

        self.assertIn("mitochondria", seen["lesson"])
        self.assertTrue(data["graded_against_lesson"])

    def test_a_missing_session_grades_blind_and_admits_it(self):
        async def fake(api_key, title, question, answer, language, lesson=""):
            self.assertEqual(lesson, "")
            return GRADED, {}

        with patch("app.main.assess", fake):
            data = self.client.post("/api/assess", json={
                "api_key": "sk-x", "question": "Q?", "answer": "A.",
                "session_id": "expired-or-never-existed"}).json()

        self.assertFalse(data["graded_against_lesson"])

    def test_assess_route_surfaces_the_model_used_for_pricing(self):
        async def fake(*args, **kwargs):
            return GRADED, {"prompt_tokens": 5, "completion_tokens": 2}

        with patch("app.main.assess", fake):
            data = self.client.post(
                "/api/assess",
                json={"api_key": "sk-x", "question": "Q?", "answer": "A."},
            ).json()

        self.assertEqual(data["assessment"], GRADED)
        self.assertIn(data["model"], PRICING)


if __name__ == "__main__":
    unittest.main()
