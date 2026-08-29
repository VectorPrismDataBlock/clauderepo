import asyncio
import unittest
from unittest.mock import patch

from app.realtime import mint_client_secret


class FakeResponse:
    is_error = False

    def json(self):
        return {"value": "secret-value"}


class FakeClient:
    last_payload = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, *args, **kwargs):
        type(self).last_payload = kwargs["json"]
        return FakeResponse()


class RealtimeSessionTests(unittest.TestCase):
    def test_manual_mode_uses_no_auto_turn_detection(self):
        with patch("app.realtime.httpx.AsyncClient", FakeClient):
            secret = asyncio.run(
                mint_client_secret("test-key", "test instructions", listening_mode="manual")
            )

        self.assertEqual(secret, "secret-value")
        self.assertEqual(
            FakeClient.last_payload["session"]["audio"]["input"]["turn_detection"],
            {"type": "none"},
        )


if __name__ == "__main__":
    unittest.main()
