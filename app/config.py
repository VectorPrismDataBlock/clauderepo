from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

# OpenAI Realtime (GA endpoints, 2026).
CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
REALTIME_MODEL = "gpt-realtime-2.1"
DEFAULT_VOICE = "marin"

# Transcribes the student's speech so we can show it in the transcript pane.
INPUT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"

# "semantic_vad" lets the model decide when the student has actually finished a
# thought rather than cutting off at the first pause. This is what makes the
# active-listening mode work: no push-to-talk, the server detects turn ends.
TURN_DETECTION = {"type": "semantic_vad"}

# --- Turn-based pipeline engine (the low-cost option) ----------------------
# Realtime bills audio tokens on both legs. This engine replaces them with
# per-minute speech-to-text, a text-only completion, and free browser speech
# synthesis. You pay latency for it: ~1.5-3s to first audio instead of ~0.5s.
TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions"
CHAT_URL = "https://api.openai.com/v1/chat/completions"

PIPELINE_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
PIPELINE_CHAT_MODEL = "gpt-4o-mini"

# The voice rules cap turns at 2-4 sentences, so this is a runaway guard.
PIPELINE_MAX_TOKENS = 400

# Unlike Realtime, we hold the conversation ourselves and resend it every turn.
# The lesson (up to MAX_LESSON_CHARS) sits in the system message, which stays
# first and byte-identical all session so it hits automatic prompt caching.
# Only the tail of the dialogue is variable, and we cap that.
PIPELINE_HISTORY_TURNS = 10

# A pipeline session lives in server memory (it holds the key) until End, the
# socket drops, or this expires.
SESSION_TTL_SECONDS = 3600

ENGINES = {
    "realtime": {
        "label": "Realtime — lowest latency, highest cost",
        "description": "WebRTC to the Realtime model. Full duplex: interrupt any time.",
    },
    "pipeline": {
        "label": "Turn-based — low cost, some latency",
        "description": "Speech-to-text, a text model, then browser speech. One speaker at a time.",
    },
}

# Rough guard so a pasted page doesn't blow past the model's context.
MAX_LESSON_CHARS = 20_000

# Lesson fetching.
FETCH_TIMEOUT = 20
FETCH_USER_AGENT = "Mozilla/5.0 (compatible; VoiceTutor/0.1)"
