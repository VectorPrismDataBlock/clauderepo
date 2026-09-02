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
  main.py       routes: /api/modes, /api/engines, /api/pricing, /api/assess,
                /api/lesson, /api/lesson/proxy, /api/session, and the
                turn-based socket /api/pipeline/ws/{id}
  prompts.py    the four learning-mode prompts + instruction builder
  lesson.py     URL fetch + HTML -> plain text (stdlib HTMLParser, no deps)
  realtime.py   exchanges the user's API key for an ephemeral client secret
  pipeline.py   transcription + streaming text completion for the cheap engine
  session.py    server-held conversation state for the cheap engine
  assess.py     grades one answer, for the proficiency gauge
  config.py     models, voice, VAD, engine, PRICING, scoring constants
static/
  index.html    three-pane UI; chat pane is bar / meters / drawer / transcript
  app.js        both engines, transcript, speech synthesis, cost, scoring, archive
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

## Tracking a student

The transcript owns the chat pane. Above it sits one compact strip: two small
meters and their numbers. Everything else -- the learner profile, the session
summary, the export controls -- lives in a drawer that is collapsed by default,
because it is reference data rather than something to watch while you talk.

Everything shown is derived from real API usage and real graded answers, not
inferred from turn counts.

### Cost ticker

The API returns no cost figure on any request, so a per-turn cost is always
reconstructed. What matters is how good the inputs are, and the panel says so
rather than presenting one confident number.

**Quantities.** Token counts come from OpenAI: the `usage` block on each
completion (cached tokens included), and `response.usage` on Realtime's
`response.done`. Transcription is billed per minute *and* per 1M audio tokens,
so the ticker prefers whatever usage the API reports and only falls back to
measuring the clip itself. When it does measure, it decodes the recording for
its true duration rather than timing the recorder with a wall clock, and the
fine print counts how many legs were measured that way.

**Rates** come from `PRICING` in `app/config.py`, checked against
developers.openai.com on `PRICING_AS_OF`. One caveat is recorded there: the
pricing page lists `gpt-realtime`, while `REALTIME_MODEL` is a dated snapshot
that is not priced separately, so it is billed at the base model's rates.

**When it cannot price something, it says so.** A model with no rate on file,
or a usage payload that reports tokens but prices to zero because its shape
moved, is counted as `unpriced` in the fine print instead of quietly costing
nothing. Silent under-reporting was the failure mode worth designing against.

The meter reads spend against an editable per-session budget
(`DEFAULT_SESSION_BUDGET_USD`). A budget is what makes an arc meaningful --
without a limit to read against, a dial for a running total would be
decoration. The fill turns amber at 80% and red at 100%, and the sparkline
below traces cumulative spend across the session's calls.

### Proficiency gauge

After every student answer, `POST /api/assess` grades that one exchange with a
small model and strict JSON output, returning a concept, a verdict
(`correct` / `partial` / `incorrect` / `off_topic`) and a one-clause note.

Two decisions worth knowing:

- **It runs off the latency path.** The call fires after the tutor's reply is
  already playing, and it is never awaited. If it fails, the lesson carries on
  ungraded.
- **The prompt carries the lesson itself**, in the system message where it is a
  stable prefix and hits the prompt cache from the second graded answer onward.
  An earlier version sent only the lesson *title* to save tokens; with nothing
  to check an answer against, the grader returned `partial` every single time
  and the gauge sat at exactly 50% forever. A grader needs ground truth.
  `app/session.py` keeps the lesson for both engines so the grader can reach it
  (Realtime's copy holds no API key -- `/api/assess` brings its own).
- **The rubric forbids the hedge.** `partial` means genuinely half right, not
  "unsure". If the answer is `off_topic` it scores nothing either way.

The gauge is an exponentially weighted average (`PROF_ALPHA`, 0.3), so it tracks
where the student is *now* rather than averaging away a recovery. `off_topic`
scores nothing either way.

### About those two dials

Both meters are the same 240-degree arc, 84px wide, side by side on one row.
Proficiency is a ratio against a limit and cost is a ratio against a budget --
which is what a meter is for. Neither is a donut or a pie; nothing is being
compared by angle.

They are deliberately small -- 44px, dial beside its reading, both on one row
about 60px tall. The transcript is the product; the meters are instrumentation,
and instrumentation that crowds out the thing it measures is worse than none.
The transcript holds roughly 77% of the chat pane with the drawer shut and 41%
with it open, and it has a floor so it can never be squeezed out entirely.

**The budget defaults are per engine and that matters.** A Realtime turn costs
around a hundred times a pipeline turn. One budget for both left the pipeline
meter at a fraction of a percent all session, which reads as a dead dial rather
than a cheap one. Both defaults are sized so a turn moves the arc a few percent;
`tests/test_assess.py` asserts that a turn is worth between 1% and 20% of budget
on each engine, so the meter cannot silently go dead again.

Three rules they follow, all worth keeping if you edit them:

- **The fill carries state, one colour at a time,** from the fixed status
  palette (`--good` / `--warning` / `--critical`). Those three were validated
  against this app's actual panel colour: all clear 3:1 contrast, and the
  worst normal-vision pair separation is Delta E 27.6, well over the 15 floor.
  A fourth status step was dropped because it collided with amber.
- **The state is always named in the label** underneath, so the colour is never
  the only thing carrying the meaning.
- **The threshold ticks are neutral grey,** not coloured. They are scaffolding
  showing where the bands fall, not state.

Arc geometry is hardcoded in `index.html` and re-derived in
`tests/frontend_math.test.js`, which also asserts that every state class a band
can emit exists as a `.dial-fill` rule -- otherwise the arc silently stays grey.

### Learner profile

Graded answers roll up by concept across every stored session, as
`attempts` / `score` chips: green where the student is reliable (2+ attempts at
75%+), red where they are not (45% or below). The same roll-up is what gets
written into the tutor's system prompt as `LEARNER MEMORY`, so the tutor adapts
on named concepts with real hit rates instead of a vague summary.

### Sessions

Every session is stored whole: turns, assessments, cost, settings. The picker
reloads any of them into the transcript pane read-only.

- **Clear chat** only clears the view. The recording continues and the picker
  brings it straight back.
- **Delete** drops the session being viewed; **Forget all** wipes the archive
  and the profile with it. Both ask first.
- **Export JSON** writes the lot -- every session, transcript, assessment and
  cost, plus the rate table that produced those costs so the figures stay
  interpretable later. It never contains the API key.

```jsonc
{
  "schema": "voice-tutor/2",
  "exportedAt": "...",
  "pricing": { "as_of": "...", "rates": { } },
  "totals": { "sessions": 3, "estimatedCostUsd": 0.0412, "gradedAnswers": 21 },
  "profile": { "concepts": [{ "concept": "photosynthesis", "attempts": 4,
                              "score": 3.5, "ratio": 0.875, "note": "..." }] },
  "sessions": [{ "id": "...", "title": "...", "engine": "pipeline",
                 "turns": [], "assessments": [], "cost": { } }]
}
```

Storage is `localStorage` under one key, `voice-tutor-store`. No auth, no
database, no server-side record of a student -- and therefore per-browser only.

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
- History is per-browser `localStorage`. Clearing site data loses it, it does
  not follow a student to another machine, and a long archive can hit the
  storage quota (the status line says so; export and Forget all).
- The `PRICING` table was checked on `PRICING_AS_OF` and rates move. `REALTIME_MODEL`
  is billed at the base `gpt-realtime` rate because the dated snapshot is not
  priced separately.
- Clip timing is only used when the API reports no usage of its own. Decoded
  duration is exact, but whether OpenAI rounds up or applies a minimum is not
  something this can know -- that leg is the softest figure on screen.
- Grading is one small model's opinion of one exchange. It reads the lesson, but
  it is good enough to steer a gauge, not to grade a course. When a session has
  expired, grading falls back to a blind rubric and the reading says how many
  answers were scored that way.
- No auth or rate limiting.
- `MAX_LESSON_CHARS` (20k) truncates long lessons rather than chunking them.
- If `POST /api/session` returns a 400 about unknown parameters, the Realtime
  session schema has moved — check `audio.input.transcription` and
  `audio.input.turn_detection` in `app/realtime.py` against the current docs.

## Tests

```bash
python -m unittest discover -s tests   # backend
node tests/frontend_math.test.js       # cost + gauge arithmetic
```

The second one matters: the ticker and the gauge are the two places where a
wrong number still looks completely plausible on screen.
