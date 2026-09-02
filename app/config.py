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

# --- Cost estimation -------------------------------------------------------
# Checked against https://developers.openai.com/api/docs/pricing on the date
# below. Rates move: re-check before quoting anything the ticker shows. This is
# the only place prices live -- everything downstream reads from here.
#
# Caveat worth knowing: the pricing page lists `gpt-realtime`. REALTIME_MODEL is
# a dated snapshot of it and is not priced separately, so it is billed here at
# the base model's rates.
PRICING_AS_OF = "2026-09-02"

# Per 1M tokens, except `per_minute`, which is per minute of audio.
# Transcription carries both: the API reports token usage when it can, and the
# per-minute figure is the fallback when only a clip length is known.
PRICING = {
    REALTIME_MODEL: {
        "text_input": 4.00,
        "cached_input": 0.40,   # same rate for cached text and cached audio
        "audio_input": 32.00,
        "text_output": 16.00,
        "audio_output": 64.00,
    },
    INPUT_TRANSCRIPTION_MODEL: {"per_minute": 0.006, "audio_input": 2.50},
    PIPELINE_TRANSCRIPTION_MODEL: {"per_minute": 0.003, "audio_input": 1.25},
    PIPELINE_CHAT_MODEL: {
        "text_input": 0.15,
        "cached_input": 0.075,
        "text_output": 0.60,
    },
}

# A per-session spend limit, so the cost meter has a real limit to read against.
# These MUST be scaled per engine: the two are orders of magnitude apart, and a
# budget set for Realtime leaves the pipeline meter pinned at zero all session,
# which reads as a broken dial rather than a cheap one.
# Rough sizing at the rates above: a Realtime turn lands near $0.03, a pipeline
# turn near $0.0004. Both budgets are therefore about a 30-turn lesson.
DEFAULT_SESSION_BUDGET_USD = {
    "realtime": 1.00,
    "pipeline": 0.015,
}

# --- Proficiency scoring ---------------------------------------------------
# One small graded call per student answer, off the tutor's latency path. The
# prompt carries the lesson *title* and the exchange, never the lesson body,
# which is what keeps it to a fraction of a cent per turn.
ASSESS_MODEL = PIPELINE_CHAT_MODEL
ASSESS_MAX_TOKENS = 160

# What each verdict is worth when the running proficiency is computed.
VERDICT_SCORES = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0}

# Rough guard so a pasted page doesn't blow past the model's context.
MAX_LESSON_CHARS = 20_000

# Lesson fetching.
FETCH_TIMEOUT = 20
FETCH_USER_AGENT = "Mozilla/5.0 (compatible; VoiceTutor/0.1)"
