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

# Rough guard so a pasted page doesn't blow past the model's context.
MAX_LESSON_CHARS = 20_000

# Lesson fetching.
FETCH_TIMEOUT = 20
FETCH_USER_AGENT = "Mozilla/5.0 (compatible; VoiceTutor/0.1)"
