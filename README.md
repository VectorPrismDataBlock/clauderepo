# Voice Tutor

Paste a lesson URL, pick a language and a learning mode, and talk through the
page with a voice tutor.

There are two engines. They share the lesson fetcher, the mode prompts, the
transcript, and the learner memory — they differ only in how audio gets to the
model and back.

| Engine | Transport | Feel | Cost |
| --- | --- | --- | --- |
| `realtime` | WebRTC to the Realtime model | Open mic, interrupt any time, ~0.5s replies | Audio tokens in *and* out |
| `pipeline` | WebSocket, turn by turn | One speaker at a time, ~1.5-3s replies | Per-minute STT + text tokens |

Pick from the **Engine** dropdown. `realtime` is the default and is unchanged.

## Run

```bash
python -m venv .venv
.venv\Scripts\activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000, enter your OpenAI API key and a lesson URL, press
Load to preview the page, then Start and allow mic access.

Run a single worker. The turn-based engine keeps its conversation in process
memory, so a second worker will not recognise a session.

## Layout

```
┌──────────────────────────────────────────────┐
│ settings: key · URL · engine · mode · btns   │
├───────────────────────────┬──────────────────┤
│  lesson page (iframe)     │  chat history    │
│                           │  + clear chat    │
└───────────────────────────┴──────────────────┘
```

```
app/
  main.py       routes: /api/modes, /api/engines, /api/lesson, /api/lesson/proxy,
                /api/session, and the turn-based socket /api/pipeline/ws/{id}
  prompts.py    the four learning-mode prompts + instruction builder
  lesson.py     URL fetch + HTML -> plain text (stdlib HTMLParser, no deps)
  realtime.py   exchanges the user's API key for an ephemeral client secret
  pipeline.py   transcription + streaming text completion for the cheap engine
  session.py    server-held conversation state for the cheap engine
  config.py     models, voice, VAD, engine, fetch and size constants
static/
  index.html    three-pane UI
  app.js        both engines, transcript rendering, browser speech synthesis
  style.css
```

## How a `realtime` session connects

1. Browser POSTs `{api_key, lesson_url, engine, language, mode}` to `/api/session`.
2. Server fetches the URL, strips it to text, builds the tutor instructions for
   that mode and language, and calls `POST /v1/realtime/client_secrets`.
3. Server returns only the short-lived `ek_...` secret.
4. Browser opens an `RTCPeerConnection`, adds the mic track, creates an
   `oai-events` data channel, and POSTs its SDP offer to
   `POST /v1/realtime/calls` with the ephemeral secret.
5. Audio flows over the peer connection; transcripts and VAD events arrive on
   the data channel.

## How a `pipeline` session connects

1. Same POST to `/api/session`, same instructions. Nothing is sent to OpenAI
   yet — the server stores the session and returns a `session_id`.
2. Browser opens `/api/pipeline/ws/{session_id}`. The server immediately
   streams the tutor's opening turn as text deltas.
3. The browser speaks each delta with `speechSynthesis` as soon as a sentence
   completes, so speech starts before the reply is finished.
4. When the tutor stops, the mic opens. A level meter in the browser ends the
   turn after ~1.1s of silence (or press **Send**).
5. The whole utterance goes up in one WebSocket message; the server transcribes
   it, appends it to the conversation, and streams the next reply.

The socket deliberately speaks the Realtime event vocabulary
(`conversation.item.input_audio_transcription.completed`,
`response.output_audio_transcript.delta`), so the transcript pane, session
summary and learner memory are shared code that does not know which engine is
connected.

### Where the saving comes from

Realtime bills audio tokens on both legs. The pipeline sends the model text
only: speech-to-text is billed per minute of audio, the completion is text
tokens, and the tutor's voice is the browser's own synthesiser, which is free
and never touches the network. Check the current pricing pages for the ratio —
it moves.

Two things keep it cheap as the session runs:

- The lesson sits in the system message, first and byte-identical every turn,
  so it hits automatic prompt caching.
- Only the last `PIPELINE_HISTORY_TURNS` exchanges are resent; older ones are
  dropped, and a clip with no speech in it never reaches the chat model at all.

Swap models in `app/config.py` (`PIPELINE_TRANSCRIPTION_MODEL`,
`PIPELINE_CHAT_MODEL`). Nothing else knows the names.

## Controls

| Button | `realtime` | `pipeline` |
| --- | --- | --- |
| Listen | Ask for a reply (manual listening mode) | Start your turn, or **Send** to end it early |
| Mute | Silences the mic track | **Pause** — holds the turn loop |
| End | Closes the peer connection | Closes the socket and forgets the session |

Listening `auto` / `manual` works in both: `auto` ends your turn for you,
`manual` waits for the button.

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
  for the session. On `pipeline` it is worse: the server calls OpenAI on every
  turn, so it holds the key in memory until you press End, the socket drops, or
  `SESSION_TTL_SECONDS` passes. Fine locally; for anything shared, put the key
  in server-side env instead of a form field.
- `pipeline` cannot be interrupted. The prompt still tells the tutor to stop if
  the student cuts in, which only the `realtime` engine can honour.
- Browser speech synthesis quality varies by platform and language, and a voice
  for the chosen language may not be installed. To trade the saving back for
  quality, add a TTS call in `app/pipeline.py` and stream audio over the
  existing socket.
- The end-of-turn detector is a plain RMS threshold (`SPEECH_RMS` in `app.js`).
  A noisy room will end turns late; a very quiet speaker may need **Send**.
- Turn-based sessions live in process memory: single worker only, and a restart
  drops every session.
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

## Tests

```bash
python -m unittest discover -s tests
```
