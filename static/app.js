const SDP_URL = "https://api.openai.com/v1/realtime/calls";

// --- turn-based engine tuning ---------------------------------------------
const SPEECH_RMS = 0.015;        // above this counts as speech
const SILENCE_MS = 1100;         // trailing silence that ends a turn
const NO_SPEECH_MS = 12000;      // nothing said at all -> discard, don't pay for STT
const MAX_UTTERANCE_MS = 45000;  // hard cap on one student turn
const VAD_INTERVAL_MS = 50;
const SPEAK_CHUNK_CHARS = 240;   // flush to speech even without a sentence end

// The browser synthesiser needs a BCP-47 tag, the tutor prompt takes a name.
const VOICE_LANGS = {
  english: "en-US",
  spanish: "es-ES",
  french: "fr-FR",
  german: "de-DE",
  portuguese: "pt-BR",
  italian: "it-IT",
  japanese: "ja-JP",
  "mandarin chinese": "zh-CN",
};

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const els = {
  apiKey: document.getElementById("api-key"),
  url: document.getElementById("lesson-url"),
  language: document.getElementById("language"),
  engine: document.getElementById("engine"),
  mode: document.getElementById("mode"),
  difficulty: document.getElementById("difficulty"),
  pace: document.getElementById("pace"),
  listeningMode: document.getElementById("listening-mode"),
  load: document.getElementById("load"),
  start: document.getElementById("start"),
  listen: document.getElementById("listen"),
  mute: document.getElementById("mute"),
  stop: document.getElementById("stop"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  listening: document.getElementById("listening"),
  listeningText: document.getElementById("listening-text"),
  transcript: document.getElementById("transcript"),
  frame: document.getElementById("lesson-frame"),
  reader: document.getElementById("lesson-reader"),
  readerToggle: document.getElementById("reader-toggle"),
  frameEmpty: document.getElementById("lesson-empty"),
  lessonTitle: document.getElementById("lesson-title"),
  sessionSummary: document.getElementById("session-summary"),
  learnerProfile: document.getElementById("learner-profile"),
  sessionPicker: document.getElementById("session-picker"),
  deleteSession: document.getElementById("delete-session"),
  forgetAll: document.getElementById("forget-all"),
  exportBtn: document.getElementById("export"),
  profArc: document.getElementById("prof-arc"),
  profTicks: document.getElementById("prof-ticks"),
  profValue: document.getElementById("prof-value"),
  profLabel: document.getElementById("prof-label"),
  profCount: document.getElementById("prof-count"),
  profNote: document.getElementById("prof-note"),
  costArc: document.getElementById("cost-arc"),
  costTicks: document.getElementById("cost-ticks"),
  costSession: document.getElementById("cost-session"),
  costLabel: document.getElementById("cost-label"),
  costSpark: document.getElementById("cost-spark"),
  costAsof: document.getElementById("cost-asof"),
  costBreakdown: document.getElementById("cost-breakdown"),
  costClear: document.getElementById("cost-clear"),
  budget: document.getElementById("budget"),
  audio: document.getElementById("tutor-audio"),
};

let pc = null;
let dc = null;
let micStream = null;
let hasSessionStarted = false;

// Turn-based engine only.
let engine = "realtime";
let ws = null;
let recorder = null;
let stopVad = null;
let recording = false;
let paused = false;
let recordStartedAt = 0;
let speechStartedAt = 0;

// Tutor speech arrives as deltas; bank them so a whole turn is recorded once,
// and so the grader knows which question was just asked.
let tutorItem = null;
let tutorText = "";
let lastTutorTurn = "";

function noteTutorDelta(itemId, delta) {
  if (tutorItem !== itemId) {
    flushTutorTurn();
    tutorItem = itemId;
  }
  tutorText += delta;
}

/** Commit the tutor's turn to the record and return the question just asked. */
function flushTutorTurn() {
  const text = tutorText.trim();
  if (text) {
    recordTurn("tutor", text);
    lastTutorTurn = text;
  }
  tutorItem = null;
  tutorText = "";
  return lastTutorTurn;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function setListening(active, text) {
  els.listening.classList.toggle("active", active);
  els.listeningText.textContent = text;
}

// --- lesson pane ----------------------------------------------------------

async function loadLesson() {
  const url = els.url.value.trim();
  if (!url) return setStatus("Enter a lesson URL.", true);

  els.load.disabled = true;
  setStatus("Fetching lesson…");
  try {
    const res = await fetch(`/api/lesson?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not load lesson");

    // Served back through our own origin so X-Frame-Options can't block it.
    els.frame.src = `/api/lesson/proxy?url=${encodeURIComponent(url)}`;
    els.reader.textContent = data.text;
    els.frameEmpty.classList.add("hidden");
    els.readerToggle.disabled = false;
    showReader(false);
    els.lessonTitle.textContent = data.title;
    setStatus(`Loaded ${data.chars.toLocaleString()} characters. Ready to start.`);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.load.disabled = false;
  }
}

function showReader(on) {
  els.reader.classList.toggle("visible", on);
  els.frame.classList.toggle("visible", !on);
  els.readerToggle.textContent = on ? "Live page" : "Reader";
}

// --- transcript rendering -------------------------------------------------
// Tutor audio arrives as deltas keyed by item_id, so we append into the same
// bubble until the next item starts.
const bubbles = new Map();

function appendTo(itemId, who, text) {
  let el = bubbles.get(itemId);
  if (!el) {
    el = document.createElement("div");
    el.className = `turn ${who}`;
    el.innerHTML = `<span class="who">${who === "tutor" ? "Tutor" : "You"}</span><span class="body"></span>`;
    els.transcript.appendChild(el);
    bubbles.set(itemId, el);
  }
  el.querySelector(".body").textContent += text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// --- persistent store -----------------------------------------------------
// Everything lives in localStorage: no auth, no database, no server-side
// record of a student. The API key is never part of it.

const STORE_KEY = "voice-tutor-store";
const BUDGET_KEY = "voice-tutor-budget";
const STORE_VERSION = 2;
const PROF_ALPHA = 0.3;   // EWMA weight - recent answers move the gauge most
const FALLBACK_SCORES = { correct: 1, partial: 0.5, incorrect: 0 };

let store = loadStore();
let live = null;          // the session in progress, or null between sessions
let viewing = "live";     // which session the transcript pane is showing
let prices = null;        // rate table from /api/pricing

function emptyStore() {
  return { version: STORE_VERSION, sessions: [] };
}

function emptyCost() {
  return { total: 0, byKind: {}, calls: 0, trail: [], unpriced: 0, estimatedLegs: 0 };
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && raw.version === STORE_VERSION) return raw;
  } catch { /* fall through and rebuild */ }

  // Carry across whatever the pre-archive build left behind, so upgrading does
  // not silently drop a student's history.
  const migrated = emptyStore();
  try {
    const old = JSON.parse(localStorage.getItem("voice-tutor-session-history") || "[]");
    for (const entry of old) {
      migrated.sessions.push({
        id: `legacy-${entry.timestamp || Math.random().toString(36).slice(2)}`,
        title: entry.title || "Untitled lesson",
        startedAt: entry.timestamp || null,
        endedAt: entry.timestamp || null,
        imported: true,
        note: entry.summary || "",
        turns: [],
        assessments: [],
        cost: emptyCost(),
      });
    }
  } catch { /* nothing worth keeping */ }
  return migrated;
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Quota is the realistic failure here: transcripts add up.
    setStatus("Could not save history (browser storage full). Export, then Forget all.", true);
  }
}

function allSessions() {
  return live ? [live, ...store.sessions] : store.sessions;
}

function sessionById(id) {
  if (id === "live") return live;
  return store.sessions.find((s) => s.id === id) || null;
}

// --- session records ------------------------------------------------------

function beginLiveSession() {
  live = {
    id: `s-${Date.now().toString(36)}`,
    title: els.lessonTitle.textContent || "Untitled lesson",
    url: els.url.value.trim(),
    engine: els.engine.value,
    mode: els.mode.value,
    language: els.language.value,
    difficulty: els.difficulty.value,
    pace: els.pace.value,
    startedAt: new Date().toISOString(),
    endedAt: null,
    turns: [],
    assessments: [],
    cost: emptyCost(),
  };
  viewing = "live";
  renderAll();
}

function endLiveSession() {
  if (!live) return;
  live.endedAt = new Date().toISOString();
  live.title = els.lessonTitle.textContent || live.title;
  live.proficiency = proficiencyOf(live);

  // Only archive sessions where something actually happened.
  if (live.turns.length) {
    store.sessions.unshift(live);
    saveStore();
    // Keep looking at what just finished, so the score and cost stay on screen.
    viewing = live.id;
  }
  live = null;
  renderAll();
}

function recordTurn(role, text) {
  if (!live || !text.trim()) return;
  live.turns.push({ role, text: text.trim(), at: new Date().toISOString() });
}

// --- cost ticker ----------------------------------------------------------
// Both engines report raw usage and all the arithmetic happens here, so there
// is one implementation and one rate table to correct.

function rateFor(model) {
  return (prices && prices.rates && prices.rates[model]) || null;
}

/** Price one reported call. Returns null when the model has no rate on file. */
function priceUsage(kind, model, detail) {
  const rate = rateFor(model);
  if (!rate) return null;

  if (kind === "stt") {
    const reported = detail.usage || {};
    // Prefer what the API billed us for. Audio token counts are the real
    // quantity; our own clip timing is an educated guess about it.
    const tokens = reported.input_token_details?.audio_tokens
      ?? (reported.type === "tokens" ? reported.input_tokens : 0);
    if (tokens && rate.audio_input) {
      return { usd: (tokens * rate.audio_input) / 1e6, measured: "reported" };
    }
    const seconds = reported.type === "duration" ? reported.seconds : (detail.seconds || 0);
    return { usd: (seconds / 60) * (rate.per_minute || 0), measured: "measured" };
  }

  const usage = detail.usage || {};

  if (kind === "realtime") {
    const input = usage.input_token_details || {};
    const output = usage.output_token_details || {};
    const cachedParts = input.cached_tokens_details || {};
    // Older payloads report one cached total with no split; treat it as text.
    const hasSplit = "text_tokens" in cachedParts || "audio_tokens" in cachedParts;
    const cachedText = hasSplit ? (cachedParts.text_tokens || 0) : (input.cached_tokens || 0);
    const cachedAudio = hasSplit ? (cachedParts.audio_tokens || 0) : 0;
    const text = Math.max(0, (input.text_tokens || 0) - cachedText);
    const audio = Math.max(0, (input.audio_tokens || 0) - cachedAudio);

    const usd = (
      text * (rate.text_input || 0) +
      audio * (rate.audio_input || 0) +
      (cachedText + cachedAudio) * (rate.cached_input || 0) +
      (output.text_tokens || 0) * (rate.text_output || 0) +
      (output.audio_tokens || 0) * (rate.audio_output || 0)
    ) / 1e6;

    // A turn that reports tokens but prices to zero means the payload shape is
    // not what this code expects. Say so rather than quietly billing nothing.
    const reported = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    if (!usd && reported) return { usd: 0, unpriced: true };
    return { usd, measured: "reported" };
  }

  // Chat-completions shape, used by both the tutor reply and the grader.
  const details = usage.prompt_tokens_details || {};
  const cached = details.cached_tokens || 0;
  const fresh = Math.max(0, (usage.prompt_tokens || 0) - cached);
  const out = usage.completion_tokens || 0;
  const cachedRate = rate.cached_input === undefined ? (rate.text_input || 0) : rate.cached_input;

  const usd = (
    fresh * (rate.text_input || 0) +
    cached * cachedRate +
    out * (rate.text_output || 0)
  ) / 1e6;

  const reported = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  if (!usd && reported) return { usd: 0, unpriced: true };
  return { usd, measured: "reported" };
}

function recordUsage(kind, model, detail) {
  if (!live) return;

  const priced = priceUsage(kind, model, detail);
  if (!priced) {
    // No rate on file for this model at all.
    live.cost.unpriced = (live.cost.unpriced || 0) + 1;
    return renderCost();
  }
  if (priced.unpriced) {
    // Tokens were reported but priced to nothing: the payload shape moved.
    live.cost.unpriced = (live.cost.unpriced || 0) + 1;
    return renderCost();
  }

  live.cost.total += priced.usd;
  live.cost.byKind[kind] = (live.cost.byKind[kind] || 0) + priced.usd;
  live.cost.calls += 1;
  if (priced.measured === "measured") live.cost.estimatedLegs = (live.cost.estimatedLegs || 0) + 1;

  // Cumulative trail for the sparkline.
  (live.cost.trail = live.cost.trail || []).push(live.cost.total);
  renderCost();
}

function money(usd) {
  if (!usd) return "$0.0000";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function allTimeCost() {
  return allSessions().reduce((sum, s) => sum + ((s.cost && s.cost.total) || 0), 0);
}

function clearTicker() {
  const shown = sessionById(viewing);
  if (!shown) return;
  shown.cost = emptyCost();
  if (shown !== live) saveStore();
  renderCost();
  setStatus("Cost ticker cleared for this session.");
}

// --- proficiency ----------------------------------------------------------

function verdictScore(verdict) {
  const scores = (prices && prices.verdict_scores) || FALLBACK_SCORES;
  // off_topic is deliberately absent: it scores nothing either way.
  return verdict in scores ? scores[verdict] : null;
}

/** Exponentially weighted, so the gauge tracks where the student is now. */
function proficiencyOf(session) {
  const scores = ((session && session.assessments) || [])
    .map((a) => verdictScore(a.verdict))
    .filter((v) => v !== null);
  if (!scores.length) return null;

  let value = scores[0];
  for (let i = 1; i < scores.length; i++) value += PROF_ALPHA * (scores[i] - value);
  return value;
}

function proficiencyBand(value) {
  if (value < 0.35) return { label: "Finding your feet", cls: "low" };
  if (value < 0.6) return { label: "Building", cls: "mid" };
  if (value < 0.8) return { label: "Solid", cls: "" };
  return { label: "Strong", cls: "" };
}

async function gradeAnswer(question, answer) {
  const api_key = els.apiKey.value.trim();
  if (!api_key || !question || !live) return;

  try {
    const res = await fetch("/api/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key,
        question,
        answer,
        lesson_title: live.title,
        language: els.language.value,
      }),
    });
    if (!res.ok) return; // grading is best-effort and never interrupts the lesson
    const data = await res.json();

    live.assessments.push({ ...data.assessment, at: new Date().toISOString() });
    recordUsage("assess", data.model, { usage: data.usage });
    renderProficiency();
    renderProfile();
    renderSummary();
  } catch { /* offline or key rejected - the tutor carries on regardless */ }
}

// --- learner profile ------------------------------------------------------

/** Roll every graded answer up by concept, across all sessions. */
function conceptTallies() {
  const byConcept = new Map();

  for (const session of allSessions()) {
    for (const item of session.assessments || []) {
      const score = verdictScore(item.verdict);
      const name = (item.concept || "").trim();
      if (score === null || !name) continue;

      const key = name.toLowerCase();
      const tally = byConcept.get(key) || { concept: name, attempts: 0, score: 0, note: "" };
      tally.attempts += 1;
      tally.score += score;
      tally.note = item.note || tally.note;
      tally.last = item.at;
      byConcept.set(key, tally);
    }
  }

  return [...byConcept.values()]
    .map((t) => ({ ...t, ratio: t.score / t.attempts }))
    .sort((a, b) => b.attempts - a.attempts);
}

function splitProfile() {
  const tallies = conceptTallies();
  return {
    strong: tallies.filter((t) => t.attempts >= 2 && t.ratio >= 0.75),
    weak: tallies.filter((t) => t.ratio <= 0.45),
    seen: tallies,
  };
}

/** The slice of the profile that goes into the tutor's system prompt. */
function formatMemory() {
  const { strong, weak } = splitProfile();
  const name = (t) => `${t.concept} (${t.score}/${t.attempts})`;

  const parts = [
    strong.length
      ? `Solid on: ${strong.slice(0, 5).map(name).join(", ")}.`
      : "No confirmed strengths yet.",
    weak.length
      ? `Weak on: ${weak.slice(0, 5).map(name).join(", ")}.`
      : "No confirmed weak spots yet.",
  ];

  const last = store.sessions[0];
  if (last) {
    const score = last.proficiency == null
      ? "ungraded"
      : `${Math.round(last.proficiency * 100)}%`;
    parts.push(`Last session on "${last.title}" ended at ${score} proficiency.`);
  }
  return parts.join(" ");
}

// --- dials ----------------------------------------------------------------
// Both meters are the same 240-degree arc, so proficiency and spend read as one
// pair. Geometry is fixed in the markup; only the dash offset, the state class
// and the ticks are computed.

const DIAL = { cx: 60, cy: 52, r: 40, start: 210, sweep: 240, length: 167.55 };

/** Point on the arc at fraction f of the sweep, at radius `radius`. */
function dialPoint(f, radius) {
  const angle = ((DIAL.start - DIAL.sweep * f) * Math.PI) / 180;
  return {
    x: DIAL.cx + radius * Math.cos(angle),
    y: DIAL.cy - radius * Math.sin(angle),
  };
}

/** Neutral threshold marks, drawn inside the track. */
function renderTicks(group, fractions) {
  group.innerHTML = fractions
    .map((f) => {
      const inner = dialPoint(f, 30);
      const outer = dialPoint(f, 34.5);
      return `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" `
        + `x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" />`;
    })
    .join("");
}

function setDial(arc, fraction, state) {
  const clamped = Math.max(0, Math.min(1, fraction));
  arc.style.strokeDashoffset = `${DIAL.length * (1 - clamped)}`;
  arc.setAttribute("class", `dial-fill ${state}`);
}

/** Cumulative spend, de-emphasised, with the current point in the accent. */
function renderSparkline(svg, trail) {
  if (!trail || trail.length < 2) {
    svg.innerHTML = "";
    return;
  }

  // Keep the last 12 points, as the stat-tile contract calls for.
  const points = trail.slice(-12);
  const peak = Math.max(...points) || 1;
  const step = 100 / (points.length - 1);
  const y = (v) => 20 - (v / peak) * 18;

  const line = points.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = points[points.length - 1];
  svg.innerHTML =
    `<polyline points="${line}" vector-effect="non-scaling-stroke" />`
    + `<circle cx="100" cy="${y(last).toFixed(2)}" r="2" vector-effect="non-scaling-stroke" />`;
}

// --- rendering ------------------------------------------------------------

const PROF_TICKS = [0.35, 0.6, 0.8];   // the band boundaries, drawn neutral
const COST_TICKS = [0.5, 0.8];         // half budget, and the warning line

function renderProficiency() {
  const session = sessionById(viewing);
  const stored = session && session.proficiency;
  const value = stored == null ? proficiencyOf(session) : stored;
  const graded = ((session && session.assessments) || []).length;

  renderTicks(els.profTicks, PROF_TICKS);
  els.profCount.textContent = graded ? `${graded} graded` : "";

  if (value == null) {
    setDial(els.profArc, 0, "");
    els.profValue.textContent = "--";
    els.profLabel.textContent = session
      ? "Answer a question to start scoring."
      : "Not assessed yet.";
    els.profNote.textContent = "";
    return;
  }

  const band = proficiencyBand(value);
  setDial(els.profArc, value, band.cls);
  els.profValue.textContent = `${Math.round(value * 100)}%`;
  // The state is always named, never carried by the colour alone.
  els.profLabel.innerHTML = `<span class="state">${band.label}</span>`;

  const weakest = (session.assessments || []).slice(-1)[0];
  els.profNote.textContent = weakest ? `Last: ${weakest.concept} — ${weakest.verdict}` : "";
}

function renderCost() {
  const session = sessionById(viewing);
  const cost = (session && session.cost) || emptyCost();
  const budget = currentBudget();
  const fraction = budget > 0 ? cost.total / budget : 0;

  renderTicks(els.costTicks, COST_TICKS);
  els.costSession.textContent = money(cost.total);
  setDial(els.costArc, fraction, costState(fraction));
  renderSparkline(els.costSpark, cost.trail);

  if (!budget) {
    els.costLabel.textContent = `${money(allTimeCost())} all time`;
  } else if (fraction > 1) {
    els.costLabel.innerHTML =
      `<span class="state">${money(cost.total - budget)} over</span> the ${money(budget)} budget`;
  } else {
    els.costLabel.innerHTML =
      `<span class="state">${Math.round(fraction * 100)}%</span> of ${money(budget)}`;
  }

  els.costAsof.textContent = prices ? `rates ${prices.as_of}` : "no rates";
  els.costBreakdown.textContent = costBreakdown(cost);
}

function costState(fraction) {
  if (fraction >= 1) return "critical";
  if (fraction >= 0.8) return "warning";
  return "good";
}

/** One line of fine print that says what the figure is made of, and how
 *  much of it was measured here rather than reported by the API. */
function costBreakdown(cost) {
  if (!prices) return "No rate table loaded — nothing priced.";

  const parts = Object.entries(cost.byKind)
    .filter(([, usd]) => usd > 0)
    .map(([kind, usd]) => `${kind} ${money(usd)}`);

  if (!parts.length && !cost.unpriced) return `${money(allTimeCost())} all time`;

  const notes = [];
  if (parts.length) notes.push(parts.join(" · "));
  if (cost.estimatedLegs) notes.push(`${cost.estimatedLegs} timed here`);
  if (cost.unpriced) notes.push(`${cost.unpriced} unpriced`);
  return notes.join(" · ");
}

// --- budget ---------------------------------------------------------------
// The meter needs a limit to read against, or the arc means nothing.

function currentBudget() {
  const value = parseFloat(els.budget.value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function saveBudget() {
  localStorage.setItem(BUDGET_KEY, els.budget.value);
  renderCost();
}

function restoreBudget(fallback) {
  const saved = localStorage.getItem(BUDGET_KEY);
  els.budget.value = saved === null ? fallback : saved;
}

function renderProfile() {
  const { strong, weak, seen } = splitProfile();
  const chip = (t, cls) => `<span class="chip ${cls}">${t.concept} ${t.score}/${t.attempts}</span>`;

  const rows = [];
  if (strong.length) rows.push(`<li>${strong.slice(0, 6).map((t) => chip(t, "good")).join("")}</li>`);
  if (weak.length) rows.push(`<li>${weak.slice(0, 6).map((t) => chip(t, "weak")).join("")}</li>`);
  if (!rows.length) {
    rows.push(seen.length
      ? `<li>${seen.slice(0, 6).map((t) => chip(t, "")).join("")}</li>`
      : "<li>No graded answers yet - the profile fills in as you talk.</li>");
  }

  const note = (weak[0] && weak[0].note) || (strong[0] && strong[0].note);
  if (note) rows.push(`<li class="fine">${note}</li>`);

  els.learnerProfile.innerHTML = rows.join("");
}

function renderSessions() {
  const liveLabel = live ? "Live session" : "Live session (not started)";
  const options = [
    `<option value="live"${viewing === "live" ? " selected" : ""}>${liveLabel}</option>`,
    ...store.sessions.map((s) => {
      const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : "unknown date";
      const score = s.proficiency == null ? "" : ` · ${Math.round(s.proficiency * 100)}%`;
      const selected = viewing === s.id ? " selected" : "";
      return `<option value="${s.id}"${selected}>${s.title} — ${when}${score}</option>`;
    }),
  ];
  els.sessionPicker.innerHTML = options.join("");
  els.deleteSession.disabled = viewing === "live";
}

function renderSummary() {
  const session = sessionById(viewing);
  if (!session) {
    els.sessionSummary.textContent = "No session yet.";
    return;
  }
  if (session.imported) {
    els.sessionSummary.textContent = session.note || "Imported from an earlier version.";
    return;
  }

  const tutor = session.turns.filter((t) => t.role === "tutor").length;
  const student = session.turns.filter((t) => t.role === "student").length;
  const graded = session.assessments.length;
  const missed = session.assessments.filter((a) => a.verdict === "incorrect").length;

  const bits = [`${tutor} tutor / ${student} student turns`];
  if (graded) bits.push(`${graded} graded, ${missed} missed`);
  bits.push(money((session.cost && session.cost.total) || 0));
  if (session.engine) bits.push(session.engine);

  els.sessionSummary.textContent = bits.join(" · ");
}

/** Show whichever session the picker points at. */
function renderTranscript() {
  if (viewing === "live") {
    els.transcript.classList.remove("archived");
    return; // the live transcript is built up by appendTo as it happens
  }

  const session = sessionById(viewing);
  els.transcript.classList.add("archived");
  els.transcript.innerHTML = "";
  bubbles.clear();

  if (!session || !session.turns.length) {
    const why = (session && session.note) || "No transcript saved for this session.";
    els.transcript.innerHTML = `<p class="archive-banner">${why}</p>`;
    return;
  }

  const when = session.startedAt ? new Date(session.startedAt).toLocaleString() : "";
  els.transcript.innerHTML =
    `<p class="archive-banner">Archived · ${session.title} · ${when}</p>`;
  for (const turn of session.turns) {
    appendTo(`${session.id}-${turn.at}-${turn.role}`, turn.role, turn.text);
  }
}

function renderAll() {
  renderSessions();
  renderTranscript();
  renderProficiency();
  renderCost();
  renderProfile();
  renderSummary();
}

// Kept under the old name: handleEvent calls it after every turn.
function updateSessionSummary() {
  renderSummary();
  renderProficiency();
}

function syncProfileUI() {
  renderAll();
}

// --- archive controls -----------------------------------------------------

function pickSession() {
  viewing = els.sessionPicker.value;
  renderAll();
  if (viewing !== "live") setStatus("Viewing an archived session. Pick Live session to go back.");
}

function deleteViewedSession() {
  const session = sessionById(viewing);
  if (viewing === "live" || !session) return;
  if (!confirm(`Delete the saved session "${session.title}"? This cannot be undone.`)) return;

  store.sessions = store.sessions.filter((s) => s.id !== viewing);
  saveStore();
  viewing = "live";
  renderAll();
  setStatus("Session deleted.");
}

function forgetAll() {
  if (!store.sessions.length) return setStatus("Nothing saved to forget.");
  const message = `Delete all ${store.sessions.length} saved sessions and the learner profile?`
    + " Export first if you want a copy.";
  if (!confirm(message)) return;

  store = emptyStore();
  saveStore();
  viewing = "live";
  renderAll();
  setStatus("All saved history deleted.");
}

function clearChat() {
  // View only. The session record and everything derived from it survive, and
  // the picker brings any of it back.
  els.transcript.innerHTML = "";
  bubbles.clear();
  setStatus(viewing === "live" && live
    ? "Transcript cleared from view - the session is still being recorded."
    : "Transcript cleared from view.");
}

// --- export ---------------------------------------------------------------

function exportJSON() {
  const payload = {
    schema: "voice-tutor/2",
    exportedAt: new Date().toISOString(),
    // Rates travel with the data so a cost figure stays interpretable later.
    pricing: prices ? { as_of: prices.as_of, rates: prices.rates } : null,
    totals: {
      sessions: allSessions().length,
      estimatedCostUsd: Number(allTimeCost().toFixed(6)),
      gradedAnswers: allSessions().reduce((n, s) => n + (s.assessments || []).length, 0),
    },
    profile: { concepts: conceptTallies() },
    sessions: allSessions(),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `voice-tutor-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${payload.totals.sessions} session(s) as JSON.`);
}

async function loadPricing() {
  try {
    prices = await (await fetch("/api/pricing")).json();
  } catch {
    prices = null; // the ticker says so rather than inventing a number
  }
  restoreBudget(prices ? prices.default_budget_usd : 0.25);
  renderCost();
}

function handleEvent(event) {
  switch (event.type) {
    // Server VAD heard the student start/stop talking — this is the visible
    // half of "active listening".
    case "input_audio_buffer.speech_started":
      speechStartedAt = Date.now();
      setListening(true, "Hearing you…");
      break;
    case "input_audio_buffer.speech_stopped":
      // Realtime bills input transcription per minute, and only the browser
      // knows how long the student actually spoke.
      if (speechStartedAt) {
        recordUsage("stt", prices?.models?.realtime_stt, {
          seconds: (Date.now() - speechStartedAt) / 1000,
        });
        speechStartedAt = 0;
      }
      setListening(false, "Listening");
      break;

    case "conversation.item.input_audio_transcription.completed": {
      const said = event.transcript || "";
      appendTo(`student-${event.item_id}`, "student", said);
      const question = flushTutorTurn();
      recordTurn("student", said);
      gradeAnswer(question, said); // deliberately not awaited
      updateSessionSummary();
      break;
    }

    // GA event name, plus the older alias, so this keeps working either way.
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      appendTo(`tutor-${event.item_id}`, "tutor", event.delta || "");
      noteTutorDelta(event.item_id, event.delta || "");
      // Realtime sends real audio alongside this. The turn-based engine sends
      // text only, so the browser speaks it as the sentences land.
      if (engine === "pipeline") queueSpeech(event.delta || "");
      updateSessionSummary();
      break;

    // Turn-based engine reports raw usage per call; the ticker prices it.
    case "usage":
      recordUsage(event.kind, event.model, event);
      break;

    // Turn-based engine: the reply is complete, so hand the floor back once
    // the synthesiser has finished saying it.
    case "response.done":
      // Realtime attaches token usage here -- the only place the browser can
      // see what a turn cost.
      if (event.response?.usage) {
        recordUsage("realtime", prices?.models?.realtime, { usage: event.response.usage });
      }
      flushTutorTurn();
      if (engine === "pipeline") endTutorTurn();
      break;

    // Turn-based engine: the clip held no speech, so no completion was billed.
    case "response.skipped":
      setStatus("Didn't catch that — go ahead when you're ready.");
      openFloor();
      break;

    case "error":
      setStatus(`Session error: ${event.error?.message || "unknown"}`, true);
      if (engine === "pipeline") abandonTurn();
      break;
  }
}

// --- session lifecycle ----------------------------------------------------

async function start() {
  const api_key = els.apiKey.value.trim();
  const lesson_url = els.url.value.trim();
  if (!api_key) return setStatus("Enter your OpenAI API key.", true);
  if (!lesson_url) return setStatus("Enter a lesson URL.", true);

  els.start.disabled = true;
  engine = els.engine.value || "realtime";
  paused = false;
  setStatus("Creating session…");

  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key,
        lesson_url,
        engine,
        language: els.language.value,
        mode: els.mode.value,
        listening_mode: els.listeningMode.value,
        difficulty: els.difficulty.value,
        pace: els.pace.value,
        memory: formatMemory(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to create session");

    // Show the page alongside the session if Load wasn't pressed first.
    if (!els.reader.textContent) await loadLesson();

    beginLiveSession();
    setStatus("Connecting audio…");
    if (engine === "pipeline") await connectPipeline(data.ws);
    else await connect(data.client_secret);

    els.mute.disabled = false;
    els.stop.disabled = false;
    els.engine.disabled = true;
    if (engine === "realtime") els.listen.disabled = els.listeningMode.value !== "manual";
    hasSessionStarted = true;
  } catch (err) {
    setStatus(err.message, true);
    els.start.disabled = false;
    endLiveSession(); // discards it -- nothing was said
    await teardown();
  }
}

function startListening() {
  if (engine === "pipeline") return pipelineListenButton();

  if (!dc || dc.readyState !== "open") {
    setStatus("Session is not ready yet.", true);
    return;
  }
  dc.send(JSON.stringify({ type: "response.create" }));
  setListening(false, "Listening");
  setStatus("Listening for your next answer.");
}

async function connect(ephemeralKey) {
  pc = new RTCPeerConnection();

  // Tutor's voice.
  pc.ontrack = (e) => { els.audio.srcObject = e.streams[0]; };

  // Student's mic — always open, no push-to-talk.
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTrack(micStream.getAudioTracks()[0], micStream);

  dc = pc.createDataChannel("oai-events");
  dc.addEventListener("message", (e) => handleEvent(JSON.parse(e.data)));
  dc.addEventListener("open", () => {
    if (els.listeningMode.value === "auto") {
      setStatus("Connected — just start talking, no button needed.");
      setListening(false, "Listening");
      dc.send(JSON.stringify({ type: "response.create" }));
    } else {
      setStatus("Connected — choose Listen when you are ready to speak.");
      setListening(false, "Ready");
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch(SDP_URL, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${await sdpRes.text()}`);

  await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
}

// --- turn-based engine ----------------------------------------------------
// Half duplex by design. The tutor speaks, then the mic opens, then the whole
// utterance goes up in one piece. There is no interrupting: the cheap engine
// buys its price by never streaming audio in either direction.

let discard = false;
const speech = { buffer: "", pending: 0, turnEnded: false };

async function connectPipeline(path) {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const url = new URL(path, location.href);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${scheme}//${url.host}${url.pathname}`);
  ws.addEventListener("message", (e) => handleEvent(JSON.parse(e.data)));
  ws.addEventListener("close", () => {
    if (hasSessionStarted) setListening(false, "Disconnected");
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("Could not open the tutor socket.")),
      { once: true });
  });

  // Mute means something different here: there is no live stream to silence,
  // so the button holds the turn loop instead.
  els.mute.textContent = "Pause";
  setStatus("Connected — the tutor is about to speak.");
  setListening(false, "Tutor speaking");
}

// --- speaking the reply ---------------------------------------------------
// The browser's own synthesiser: no per-character billing, no network hop, and
// it starts on the first finished sentence while the rest is still streaming.

function voiceLang() {
  return VOICE_LANGS[(els.language.value || "").trim().toLowerCase()] || "en-US";
}

function pickVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const base = lang.split("-")[0];
  return voices.find((v) => v.lang === lang) || voices.find((v) => v.lang?.startsWith(base));
}

// Index of the first real sentence end, or -1. Skips the dot in "3.5", and
// waits for the following space so a terminator mid-stream isn't cut early.
function sentenceEnd(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ("…。！？".includes(ch)) return i;
    if (!".!?".includes(ch)) continue;
    if (ch === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) continue;
    if (i + 1 < text.length && /\s/.test(text[i + 1])) return i;
  }
  return -1;
}

function say(text) {
  const line = text.trim();
  if (!line || !window.speechSynthesis) return;

  const utterance = new SpeechSynthesisUtterance(line);
  utterance.lang = voiceLang();
  const voice = pickVoice(utterance.lang);
  if (voice) utterance.voice = voice;
  utterance.onend = utterance.onerror = () => {
    speech.pending = Math.max(0, speech.pending - 1);
    if (!speech.pending && speech.turnEnded) openFloor();
  };

  speech.pending += 1;
  window.speechSynthesis.speak(utterance);
}

function flushSpeech(force) {
  for (let cut = sentenceEnd(speech.buffer); cut !== -1; cut = sentenceEnd(speech.buffer)) {
    say(speech.buffer.slice(0, cut + 1));
    speech.buffer = speech.buffer.slice(cut + 1);
  }
  if (force) {
    say(speech.buffer);
    speech.buffer = "";
  } else if (speech.buffer.length > SPEAK_CHUNK_CHARS) {
    // A long clause with no terminator in sight — break at a word boundary so
    // the student isn't left waiting on silence.
    const space = speech.buffer.lastIndexOf(" ");
    if (space > 0) {
      say(speech.buffer.slice(0, space));
      speech.buffer = speech.buffer.slice(space + 1);
    }
  }
}

function queueSpeech(delta) {
  if (speech.turnEnded) speech.turnEnded = false;
  if (!speech.buffer && !speech.pending) {
    setListening(false, "Tutor speaking");
    setStatus("Tutor is answering…");
  }
  speech.buffer += delta;
  flushSpeech(false);
}

function endTutorTurn() {
  flushSpeech(true);
  speech.turnEnded = true;
  // No synthesiser (or nothing left to say) means nothing will call us back.
  if (!speech.pending) openFloor();
}

// --- taking the student's turn --------------------------------------------

function openFloor() {
  speech.turnEnded = false;
  if (paused || ws?.readyState !== WebSocket.OPEN) return;

  if (els.listeningMode.value === "auto") {
    startRecording();
  } else {
    els.listen.disabled = false;
    els.listen.textContent = "Listen";
    setListening(false, "Ready");
    setStatus("Press Listen when you want to answer.");
  }
}

function startRecording() {
  if (recording || paused || !micStream || ws?.readyState !== WebSocket.OPEN) return;

  const supported = MIME_CANDIDATES.find(
    (m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  const chunks = [];
  discard = false;
  recorder = new MediaRecorder(micStream, supported ? { mimeType: supported } : undefined);
  const mime = recorder.mimeType || supported || "audio/webm";

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });

  recorder.addEventListener("stop", async () => {
    recording = false;
    recorder = null;
    if (stopVad) { stopVad(); stopVad = null; }
    els.listen.textContent = "Listen";
    els.listen.disabled = true;

    // Nothing worth sending. Re-open on a timer rather than straight away, so
    // a recorder that yields no data can't spin the loop.
    if (discard || !chunks.length) return void setTimeout(openFloor, 300);
    if (ws?.readyState !== WebSocket.OPEN) return;

    setListening(false, "Thinking…");
    setStatus("Transcribing…");
    const blob = new Blob(chunks, { type: mime });
    ws.send(JSON.stringify({
      type: "utterance",
      mime,
      seconds: await clipSeconds(blob),
      data: await toBase64(blob),
    }));
  });

  recorder.start();
  recordStartedAt = Date.now();
  recording = true;
  els.listen.disabled = false;
  els.listen.textContent = "Send";
  setListening(false, "Listening");
  setStatus("Your turn — speak, then pause.");

  const auto = els.listeningMode.value === "auto";
  stopVad = watchLevels(micStream, {
    onSpeech: () => setListening(true, "Hearing you…"),
    onEnd: auto ? () => finishRecording(true) : null,
    onNothing: auto ? () => finishRecording(false) : null,
  });
}

function finishRecording(send) {
  if (!recording || !recorder) return;
  discard = !send;
  try { recorder.stop(); } catch { /* already stopping */ }
}

function abandonTurn() {
  window.speechSynthesis?.cancel();
  speech.buffer = "";
  speech.pending = 0;
  speech.turnEnded = false;
  finishRecording(false);
}

function pipelineListenButton() {
  if (recording) finishRecording(true);
  else openFloor();
}

/** Poll the mic level to find the end of the student's turn. */
function watchLevels(stream, { onSpeech, onEnd, onNothing }) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null; // no level metering — the Send button still works

  const ctx = new Ctx();
  ctx.resume().catch(() => {}); // a suspended context reads as pure silence
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const started = Date.now();
  let heard = false;
  let speaking = false;
  let quietSince = 0;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();

    if (rms > SPEECH_RMS) {
      if (!speaking) { speaking = true; onSpeech(); }
      heard = true;
      quietSince = 0;
    } else if (heard) {
      speaking = false;
      if (!quietSince) quietSince = now;
      else if (now - quietSince > SILENCE_MS && onEnd) return onEnd();
    } else if (now - started > NO_SPEECH_MS && onNothing) {
      // Nothing said at all. Drop the clip rather than pay to transcribe air.
      return onNothing();
    }

    if (now - started > MAX_UTTERANCE_MS && onEnd) onEnd();
  }, VAD_INTERVAL_MS);

  return () => { clearInterval(timer); ctx.close().catch(() => {}); };
}

/** Exact decoded length of a clip, falling back to the wall clock.
 *
 * Wall-clock timing around MediaRecorder includes start-up lag and whatever
 * the event loop was busy with. Decoding gives the real audio duration, which
 * is what a per-minute rate is charged against. */
async function clipSeconds(blob) {
  const wallClock = (Date.now() - recordStartedAt) / 1000;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return wallClock;

  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return decoded.duration;
  } catch {
    return wallClock; // codec the decoder will not take
  } finally {
    ctx.close().catch(() => {});
  }
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000; // chunked: apply() blows the stack on a whole utterance
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function teardown() {
  if (dc) { dc.close(); dc = null; }
  if (pc) { pc.close(); pc = null; }
  if (ws) { ws.close(); ws = null; }
  abandonTurn();
  recorder = null;
  recording = false;
  if (stopVad) { stopVad(); stopVad = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  els.audio.srcObject = null;
}

async function stop() {
  flushTutorTurn();
  endLiveSession();

  await teardown();
  hasSessionStarted = false;
  paused = false;
  els.start.disabled = false;
  els.mute.disabled = true;
  els.stop.disabled = true;
  els.listen.disabled = true;
  els.listen.textContent = "Listen";
  els.mute.textContent = "Mute";
  els.engine.disabled = false;
  setListening(false, "Idle");
  setStatus("Session ended.");
}

function toggleMute() {
  // The turn-based engine has no live stream to silence, so the same button
  // holds the turn loop instead of muting a track.
  if (engine === "pipeline") {
    paused = !paused;
    els.mute.textContent = paused ? "Resume" : "Pause";
    if (paused) {
      abandonTurn();
      els.listen.disabled = true;
      setListening(false, "Paused");
      setStatus("Paused — press Resume to carry on.");
    } else {
      setStatus("Resumed.");
      openFloor();
    }
    return;
  }

  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  els.mute.textContent = track.enabled ? "Mute" : "Unmute";
  setListening(false, track.enabled ? "Listening" : "Muted");
}

async function loadModes() {
  const modes = await (await fetch("/api/modes")).json();
  els.mode.innerHTML = modes
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join("");
}

async function loadEngines() {
  const engines = await (await fetch("/api/engines")).json();
  els.engine.innerHTML = engines
    .map((e) => `<option value="${e.id}" title="${e.description}">${e.label}</option>`)
    .join("");
  describeEngine();
}

function describeEngine() {
  const option = els.engine.selectedOptions[0];
  els.engine.title = option ? option.title : "";
}

els.load.addEventListener("click", loadLesson);
els.start.addEventListener("click", start);
els.listen.addEventListener("click", startListening);
els.stop.addEventListener("click", stop);
els.mute.addEventListener("click", toggleMute);
els.clear.addEventListener("click", clearChat);
els.readerToggle.addEventListener("click", () =>
  showReader(!els.reader.classList.contains("visible")));
els.url.addEventListener("keydown", (e) => { if (e.key === "Enter") loadLesson(); });
els.engine.addEventListener("change", describeEngine);
els.sessionPicker.addEventListener("change", pickSession);
els.deleteSession.addEventListener("click", deleteViewedSession);
els.forgetAll.addEventListener("click", forgetAll);
els.exportBtn.addEventListener("click", exportJSON);
els.costClear.addEventListener("click", clearTicker);
els.budget.addEventListener("input", saveBudget);
els.listeningMode.addEventListener("change", () => {
  const manual = els.listeningMode.value === "manual";

  if (engine === "pipeline") {
    // Auto and manual differ only in who ends the turn, so the switch can take
    // effect mid-session. A recording already running keeps the rule it began
    // with; the change lands on the next turn.
    els.listen.disabled = !hasSessionStarted || (!manual && !recording);
    if (!manual && hasSessionStarted && !recording) openFloor();
    return;
  }

  els.listen.disabled = !hasSessionStarted || !manual;
  if (!manual && dc && dc.readyState === "open") {
    setStatus("Connected — just start talking, no button needed.");
  }
});

syncProfileUI();
loadModes();
loadEngines();
loadPricing();
