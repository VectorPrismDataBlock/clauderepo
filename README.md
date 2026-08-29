# Voice Tutor

Paste a lesson URL, pick a language and a learning mode, and talk through the
page with a voice tutor over the OpenAI Realtime API (WebRTC). The mic stays
open — server-side VAD detects when you start and stop talking, so there is no
push-to-talk.

## Run

```bash
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000, enter your OpenAI API key and a lesson URL, press
Load to preview the page, then Start and allow mic access.

## Layout

```
┌──────────────────────────────────────────────┐
│ settings: key · URL · language · mode · btns │
├───────────────────────────┬──────────────────┤
│  lesson page (iframe)     │  chat history    │
│                           │  + clear chat    │
└───────────────────────────┴──────────────────┘
```

```
app/
  main.py       routes: /api/modes, /api/lesson, /api/lesson/proxy, /api/session
  prompts.py    the four learning-mode prompts + instruction builder
  lesson.py     URL fetch + HTML -> plain text (stdlib HTMLParser, no deps)
  realtime.py   exchanges the user's API key for an ephemeral client secret
  config.py     model, voice, VAD, fetch and size constants
static/
  index.html    three-pane UI
  app.js        WebRTC setup, data-channel events, transcript rendering
  style.css
```

## How a session connects

1. Browser POSTs `{api_key, lesson_url, language, mode}` to `/api/session`.
2. Server fetches the URL, strips it to text, builds the tutor instructions for
   that mode and language, and calls `POST /v1/realtime/client_secrets`.
3. Server returns only the short-lived `ek_...` secret.
4. Browser opens an `RTCPeerConnection`, adds the mic track, creates an
   `oai-events` data channel, and POSTs its SDP offer to
   `POST /v1/realtime/calls` with the ephemeral secret.
5. Audio flows over the peer connection; transcripts and VAD events arrive on
   the data channel.

The lesson pane loads `/api/lesson/proxy`, which re-serves the fetched page from
our own origin with a `<base href>` injected. Framing the original URL directly
fails on most sites because of `X-Frame-Options` / `frame-ancestors`; the iframe
is fully sandboxed, so the page's own scripts never run.

## Learning modes

| Mode | What the tutor does |
| --- | --- |
| `overview` | Summarises, then walks the main points at altitude |
| `comprehension` | Open questions, leads you to answers instead of giving them |
| `details` | Deep dive on mechanisms, edge cases, misconceptions |
| `quiz` | Ten spoken questions, then a score and what to revisit |

Edit `app/prompts.py` to change any of them; the mode dropdown is populated from
that file via `/api/modes`.

## Known rough edges (deliberate — this is a prototype)

- **The API key round-trips through the backend** and lives in browser memory
  for the session. Fine locally; for anything shared, put the key in server-side
  env instead of a form field.
- The fetcher does not run JavaScript, so SPA-rendered lessons return 422.
- No SSRF guard on the lesson URL — the server will fetch private/internal
  addresses. Fine on localhost, not on a shared host.
- Some sites (Wikipedia among them) reject the fetcher with 403 regardless of
  User-Agent.
- "Clear chat" clears the visible transcript only; the model still has the
  earlier turns in its context. End and restart the session to reset that.
- No session persistence, auth, rate limiting, or transcript export.
- `MAX_LESSON_CHARS` (20k) truncates long lessons rather than chunking them.
- If `POST /api/session` returns a 400 about unknown parameters, the Realtime
  session schema has moved — check `audio.input.transcription` and
  `audio.input.turn_detection` in `app/realtime.py` against the current docs.
