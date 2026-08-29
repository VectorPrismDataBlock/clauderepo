const SDP_URL = "https://api.openai.com/v1/realtime/calls";

const STORAGE_KEY = "voice-tutor-profile";
const HISTORY_KEY = "voice-tutor-session-history";

const els = {
  apiKey: document.getElementById("api-key"),
  url: document.getElementById("lesson-url"),
  language: document.getElementById("language"),
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
  sessionHistory: document.getElementById("session-history"),
  audio: document.getElementById("tutor-audio"),
};

let pc = null;
let dc = null;
let micStream = null;
let hasSessionStarted = false;

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

function getStoredProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        strengths: ["Clear lesson structure", "Short explanations"],
        weaknesses: ["Follow-up questions"],
        lastSessionSummary: "No session summary yet.",
      };
    }
    return JSON.parse(raw);
  } catch {
    return {
      strengths: ["Clear lesson structure", "Short explanations"],
      weaknesses: ["Follow-up questions"],
      lastSessionSummary: "No session summary yet.",
    };
  }
}

function saveStoredProfile(profile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

function getStoredHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function formatMemory(profile) {
  const strengths = (profile.strengths || []).slice(0, 3).join(", ") || "No major strengths recorded yet.";
  const weaknesses = (profile.weaknesses || []).slice(0, 3).join(", ") || "No weak spots recorded yet.";
  const summary = profile.lastSessionSummary || "No session summary yet.";
  return `Strengths: ${strengths}. Weaknesses: ${weaknesses}. Recent session summary: ${summary}`;
}

function syncProfileUI() {
  const profile = getStoredProfile();
  const strengths = (profile.strengths || []).slice(0, 3);
  const weaknesses = (profile.weaknesses || []).slice(0, 3);

  els.learnerProfile.innerHTML = "";
  const items = [
    ...strengths.map((item) => `<li><strong>Strength:</strong> ${item}</li>`),
    ...weaknesses.map((item) => `<li><strong>Focus:</strong> ${item}</li>`),
  ];

  if (!items.length) {
    items.push("<li>No memory recorded yet.</li>");
  }

  els.learnerProfile.innerHTML = items.join("");
  els.sessionSummary.textContent = profile.lastSessionSummary || "No session summary yet.";

  const history = getStoredHistory();
  els.sessionHistory.innerHTML = history.length
    ? history.map((entry) => `<li>${entry.title}: ${entry.summary}</li>`).join("")
    : "<li>No saved sessions.</li>";
}

function clearChat() {
  els.transcript.innerHTML = "";
  bubbles.clear();
  const profile = getStoredProfile();
  profile.lastSessionSummary = "Transcript cleared. Start a fresh learning loop.";
  saveStoredProfile(profile);
  syncProfileUI();
}

function updateSessionSummary() {
  const transcript = els.transcript.textContent || "";
  if (!transcript.trim()) {
    els.sessionSummary.textContent = "No session yet.";
    return;
  }

  const tutorTurns = els.transcript.querySelectorAll(".turn.tutor").length;
  const studentTurns = els.transcript.querySelectorAll(".turn.student").length;
  const questionCount = (transcript.match(/\?/g) || []).length;
  const status = questionCount > 0 ? "Needs follow-up questions" : "Steady progress";
  const summary = `${tutorTurns} tutor turns • ${studentTurns} student turns • ${questionCount} questions • ${status}`;

  const profile = getStoredProfile();
  profile.lastSessionSummary = summary;
  if (questionCount > 0) {
    profile.weaknesses = Array.from(new Set([...(profile.weaknesses || []), "Follow-up questions"]))
      .slice(0, 4);
  }
  if (tutorTurns > studentTurns) {
    profile.strengths = Array.from(new Set([...(profile.strengths || []), "Concept review"])).slice(0, 4);
  }
  saveStoredProfile(profile);
  syncProfileUI();
}

function handleEvent(event) {
  switch (event.type) {
    // Server VAD heard the student start/stop talking — this is the visible
    // half of "active listening".
    case "input_audio_buffer.speech_started":
      setListening(true, "Hearing you…");
      break;
    case "input_audio_buffer.speech_stopped":
      setListening(false, "Listening");
      break;

    case "conversation.item.input_audio_transcription.completed":
      appendTo(`student-${event.item_id}`, "student", event.transcript || "");
      updateSessionSummary();
      break;

    // GA event name, plus the older alias, so this keeps working either way.
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      appendTo(`tutor-${event.item_id}`, "tutor", event.delta || "");
      updateSessionSummary();
      break;

    case "error":
      setStatus(`Session error: ${event.error?.message || "unknown"}`, true);
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
  setStatus("Creating session…");

  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key,
        lesson_url,
        language: els.language.value,
        mode: els.mode.value,
        listening_mode: els.listeningMode.value,
        difficulty: els.difficulty.value,
        pace: els.pace.value,
        memory: formatMemory(getStoredProfile()),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to create session");

    // Show the page alongside the session if Load wasn't pressed first.
    if (!els.reader.textContent) await loadLesson();

    setStatus("Connecting audio…");
    await connect(data.client_secret);

    els.mute.disabled = false;
    els.stop.disabled = false;
    els.listen.disabled = els.listeningMode.value !== "manual";
    hasSessionStarted = true;
  } catch (err) {
    setStatus(err.message, true);
    els.start.disabled = false;
    await teardown();
  }
}

function startListening() {
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

async function teardown() {
  if (dc) { dc.close(); dc = null; }
  if (pc) { pc.close(); pc = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  els.audio.srcObject = null;
}

async function stop() {
  updateSessionSummary();

  const history = getStoredHistory();
  const summary = els.sessionSummary.textContent || "No summary yet.";
  const title = els.lessonTitle.textContent && els.lessonTitle.textContent !== "No lesson loaded"
    ? els.lessonTitle.textContent
    : "Untitled lesson";

  history.unshift({
    title,
    summary,
    timestamp: new Date().toISOString(),
  });
  saveStoredHistory(history);
  syncProfileUI();

  await teardown();
  els.start.disabled = false;
  els.mute.disabled = true;
  els.stop.disabled = true;
  els.mute.textContent = "Mute";
  setListening(false, "Idle");
  setStatus("Session ended.");
}

function toggleMute() {
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

els.load.addEventListener("click", loadLesson);
els.start.addEventListener("click", start);
els.listen.addEventListener("click", startListening);
els.stop.addEventListener("click", stop);
els.mute.addEventListener("click", toggleMute);
els.clear.addEventListener("click", clearChat);
els.readerToggle.addEventListener("click", () =>
  showReader(!els.reader.classList.contains("visible")));
els.url.addEventListener("keydown", (e) => { if (e.key === "Enter") loadLesson(); });
els.listeningMode.addEventListener("change", () => {
  const manual = els.listeningMode.value === "manual";
  els.listen.disabled = !hasSessionStarted || !manual;
  if (!manual && dc && dc.readyState === "open") {
    setStatus("Connected — just start talking, no button needed.");
  }
});

syncProfileUI();
loadModes();
