"""Cover for the proficiency grader and the cost-ticker rate table."""

import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.assess import AssessError, assess
from app.config import PRICING, VERDICT_SCORES
from app.main import app

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

    def test_the_lesson_body_is_never_sent_only_the_title(self):
        FakeClient.response = FakeResponse(json.dumps(GRADED))
        with patch("app.assess.httpx.AsyncClient", FakeClient):
            asyncio.run(assess("k", "Cell Biology", "Q?", "A."))

        prompt = json.dumps(FakeClient.last_json)
        self.assertIn("Cell Biology", prompt)
        # Strict JSON output is what makes the gauge safe to drive directly.
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
