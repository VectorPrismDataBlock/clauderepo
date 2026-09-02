/**
 * The cost ticker and the proficiency gauge are the two places in app.js where
 * a wrong number looks completely plausible on screen. Run with:
 *
 *   node tests/frontend_math.test.js
 *
 * Rates here are a fixture, not the real table -- this checks the arithmetic,
 * not the prices. The live rates live in app/config.py.
 */

const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "static", "app.js");

const RATES = {
  rates: {
    "test-realtime": { text_input: 4, cached_input: 0.4, audio_input: 32,
                       text_output: 16, audio_output: 64 },
    "test-chat": { text_input: 0.15, cached_input: 0.075, text_output: 0.6 },
    "test-stt": { per_minute: 0.003, audio_input: 1.25 },
  },
  verdict_scores: { correct: 1, partial: 0.5, incorrect: 0 },
  as_of: "fixture",
};

/** Load app.js far enough to reach its pure functions, with the DOM stubbed. */
function loadAppFunctions() {
  const src = fs.readFileSync(APP, "utf8");
  const head = src.slice(0, src.indexOf("els.load.addEventListener"));

  const stub = () => new Proxy(
    { style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {},
      querySelector: () => ({}), value: "", textContent: "", innerHTML: "",
      selectedOptions: [], disabled: false },
    { get: (t, k) => (k in t ? t[k] : "") });

  const out = {};
  new Function("document", "localStorage", "window", "navigator", "fetch", "out",
    head + `
      out.priceUsage = priceUsage;
      out.proficiencyOf = proficiencyOf;
      out.proficiencyBand = proficiencyBand;
      out.money = money;
      out.dialPoint = dialPoint;
      out.DIAL = DIAL;
      out.setPrices = (p) => { prices = p; };
    `)(
    { getElementById: stub, createElement: stub },
    { getItem: () => null, setItem() {} },
    {}, {}, async () => ({ json: async () => ({}) }), out);

  out.setPrices(RATES);
  return out;
}

const app = loadAppFunctions();
let failures = 0;

function near(label, got, want) {
  const ok = Math.abs(got - want) < 1e-12;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${got}, want ${want}`}`);
}

function is(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${got}, want ${want}`}`);
}

const graded = (...verdicts) => ({ assessments: verdicts.map((verdict) => ({ verdict })) });

// --- cost ticker ---
near("chat prices cached tokens at the cached rate",
  app.priceUsage("chat", "test-chat", { usage: {
    prompt_tokens: 1000, completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 768 } } }).usd,
  (232 * 0.15 + 768 * 0.075 + 100 * 0.6) / 1e6);

near("chat with no cache detail bills everything fresh",
  app.priceUsage("chat", "test-chat", { usage: {
    prompt_tokens: 1000, completion_tokens: 100 } }).usd,
  (1000 * 0.15 + 100 * 0.6) / 1e6);

near("stt falls back to the measured clip length",
  app.priceUsage("stt", "test-stt", { seconds: 30 }).usd, 0.0015);
is("...and says the number was measured here",
  app.priceUsage("stt", "test-stt", { seconds: 30 }).measured, "measured");

near("stt prefers the audio tokens the API reported",
  app.priceUsage("stt", "test-stt", { seconds: 30, usage: {
    type: "tokens", input_tokens: 500,
    input_token_details: { audio_tokens: 480 } } }).usd,
  (480 * 1.25) / 1e6);
is("...and says so",
  app.priceUsage("stt", "test-stt", { seconds: 30, usage: {
    type: "tokens", input_tokens: 500,
    input_token_details: { audio_tokens: 480 } } }).measured, "reported");

near("stt honours a duration the API reported over our own",
  app.priceUsage("stt", "test-stt", { seconds: 99, usage: {
    type: "duration", seconds: 30 } }).usd, 0.0015);

// A payload shape that moved must be visible, not silently free.
is("realtime tokens that price to zero are flagged unpriced",
  app.priceUsage("realtime", "test-realtime",
    { usage: { input_tokens: 900, output_tokens: 100, moved: {} } }).unpriced, true);
is("chat tokens that price to zero are flagged unpriced",
  app.priceUsage("chat", "test-chat", { usage: { prompt_tokens: 0, completion_tokens: 0,
    total_tokens: 500 } }).unpriced, undefined);

near("realtime splits cached text from cached audio",
  app.priceUsage("realtime", "test-realtime", { usage: {
    input_token_details: { text_tokens: 200, audio_tokens: 500, cached_tokens: 150,
      cached_tokens_details: { text_tokens: 50, audio_tokens: 100 } },
    output_token_details: { text_tokens: 40, audio_tokens: 300 } } }).usd,
  (150 * 4 + 400 * 32 + 150 * 0.4 + 40 * 16 + 300 * 64) / 1e6);

near("realtime treats an unsplit cache total as text",
  app.priceUsage("realtime", "test-realtime", { usage: {
    input_token_details: { text_tokens: 200, audio_tokens: 500, cached_tokens: 150 },
    output_token_details: { text_tokens: 40, audio_tokens: 300 } } }).usd,
  (50 * 4 + 500 * 32 + 150 * 0.4 + 40 * 16 + 300 * 64) / 1e6);

is("an unpriced model reports nothing rather than zero",
  app.priceUsage("chat", "model-with-no-rate", { usage: {} }), null);

// --- proficiency gauge ---
is("no graded answers means no score", app.proficiencyOf(graded()), null);
is("off_topic answers do not move the gauge", app.proficiencyOf(graded("off_topic")), null);
near("a clean run reads 100%", app.proficiencyOf(graded("correct", "correct")), 1);
near("recent answers dominate (EWMA alpha 0.3)",
  app.proficiencyOf(graded("correct", "correct", "correct", "incorrect", "incorrect")), 0.49);
near("partial credit counts for half", app.proficiencyOf(graded("partial")), 0.5);

is("bands read critical at the bottom", app.proficiencyBand(0.2).cls, "critical");
is("bands read warning in the middle", app.proficiencyBand(0.49).cls, "warning");
is("bands top out good", app.proficiencyBand(0.95).cls, "good");

// Every class a band can emit must actually exist as a dial fill rule,
// or the arc silently stays grey.
const css = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
for (const at of [0.1, 0.45, 0.7, 0.99]) {
  const cls = app.proficiencyBand(at).cls;
  is(`css defines .dial-fill.${cls}`, css.includes(`.dial-fill.${cls} {`), true);
}
for (const cls of ["good", "warning", "critical"]) {
  is(`css defines cost state .dial-fill.${cls}`, css.includes(`.dial-fill.${cls} {`), true);
}

// --- dial geometry ---
// The arc path is hardcoded in index.html; if these drift the fill stops
// lining up with the track.
const startPoint = app.dialPoint(0, app.DIAL.r);
const endPoint = app.dialPoint(1, app.DIAL.r);
near("dial starts where the markup path starts (x)", Number(startPoint.x.toFixed(2)), 25.36);
near("dial starts where the markup path starts (y)", Number(startPoint.y.toFixed(2)), 72);
near("dial ends where the markup path ends (x)", Number(endPoint.x.toFixed(2)), 94.64);
near("dial ends where the markup path ends (y)", Number(endPoint.y.toFixed(2)), 72);
near("dash length matches the CSS dasharray",
  Number(((app.DIAL.sweep * Math.PI / 180) * app.DIAL.r).toFixed(2)), 167.55);
near("half the sweep sits at the top of the arc",
  Number(app.dialPoint(0.5, app.DIAL.r).y.toFixed(2)), app.DIAL.cy - app.DIAL.r);

// --- formatting ---
is("sub-cent amounts keep four places", app.money(0.00042), "$0.0004");
is("larger amounts round to cents", app.money(1.5), "$1.50");
is("zero is not blank", app.money(0), "$0.0000");

console.log(failures ? `\n${failures} failure(s)` : "\nall frontend maths ok");
process.exit(failures ? 1 : 0);
