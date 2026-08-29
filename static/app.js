const SDP_URL = "https://api.openai.com/v1/realtime/calls";

const els = {
  apiKey: document.getElementById("api-key"),
  url: document.getElementById("lesson-url"),
  language: document.getElementById("language"),
  mode: document.getElementById("mode"),
  load: document.getElementById("load"),
  start: document.getElementById("start"),
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
  audio: document.getElementById("tutor-audio"),
};

let pc = null;
let dc = null;
let micStream = null;

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

function clearChat() {
  els.transcript.innerHTML = "";
  bubbles.clear();
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
      break;

    // GA event name, plus the older alias, so this keeps working either way.
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      appendTo(`tutor-${event.item_id}`, "tutor", event.delta || "");
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
  } catch (err) {
    setStatus(err.message, true);
    els.start.disabled = false;
    await teardown();
  }
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
    setStatus("Connected — just start talking, no button needed.");
    setListening(false, "Listening");
    // Let the tutor open the lesson rather than waiting on the student.
    dc.send(JSON.stringify({ type: "response.create" }));
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
els.stop.addEventListener("click", stop);
els.mute.addEventListener("click", toggleMute);
els.clear.addEventListener("click", clearChat);
els.readerToggle.addEventListener("click", () =>
  showReader(!els.reader.classList.contains("visible")));
els.url.addEventListener("keydown", (e) => { if (e.key === "Enter") loadLesson(); });
loadModes();
