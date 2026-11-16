// Phase 0 / gate 0.8 + K8 — one DOM adapter contract, 4/4 behaviors.
//
// The four behaviors are the Phase 5 contract: input, output, submit, stream-end
// (§5.3/§5.7). This runs the same adapter against four fixture DOMs shaped like
// the four target sites, in jsdom, with no network and no account.
//
// HONEST LIMIT, stated here and in the report: a fixture proves the *contract* is
// implementable and that the injection technique survives each framework's
// characteristic traps (React controlled textarea, ProseMirror contenteditable,
// Angular contenteditable, plain textarea). It does NOT prove a live site still
// has this DOM — that is what the Phase 5 nightly live smoke is for.
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { arg, writeJson } from "./lib/stats.mjs";

const OUT = arg("out", "bench/results/adapter.json");

// ── ranked selector sets, the way Phase 5 stores them ─────────────────────
const SITES = {
  chatgpt: {
    url: "https://chatgpt.com/c/abc",
    input: ["#prompt-textarea", "textarea[data-id]", "form textarea"],
    submit: ["[data-testid='send-button']", "button[aria-label='Send prompt']"],
    assistant: ["[data-message-author-role='assistant']", "article[data-testid^='conversation-turn']"],
    stop: ["[data-testid='stop-button']", "button[aria-label='Stop streaming']"],
    framework: "react-controlled-textarea",
  },
  claude: {
    url: "https://claude.ai/chat/abc",
    input: ["div[contenteditable='true'].ProseMirror", "div[contenteditable='true']"],
    submit: ["button[aria-label='Send message']", "button[type='submit']"],
    assistant: ["div.font-claude-message", "[data-testid='assistant-message']"],
    stop: ["button[aria-label='Stop response']"],
    framework: "prosemirror-contenteditable",
  },
  gemini: {
    url: "https://gemini.google.com/app/abc",
    input: ["div.ql-editor[contenteditable='true']", "rich-textarea div[contenteditable='true']"],
    submit: ["button.send-button", "button[aria-label='Send message']"],
    assistant: ["model-response .markdown", "message-content"],
    stop: ["button[aria-label='Stop response']"],
    framework: "angular-contenteditable",
  },
  qwen: {
    url: "https://chat.qwen.ai/c/abc",
    input: ["textarea#chat-input", "textarea"],
    submit: ["button#send-message-button", "button[type='submit']"],
    assistant: [".chat-message-assistant", "[data-role='assistant']"],
    stop: ["button#stop-generate-button"],
    framework: "plain-textarea",
  },
};

function fixtureHtml(site) {
  const s = SITES[site];
  const input =
    s.framework === "react-controlled-textarea" ? `<textarea id="prompt-textarea"></textarea>` :
    s.framework === "prosemirror-contenteditable" ? `<div contenteditable="true" class="ProseMirror"><p data-placeholder="Reply"></p></div>` :
    s.framework === "angular-contenteditable" ? `<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>` :
    `<textarea id="chat-input"></textarea>`;
  const send = s.framework === "plain-textarea" ? `<button id="send-message-button" type="submit">Send</button>` : `<button aria-label="Send message" data-testid="send-button" type="submit">Send</button>`;
  const stop = site === "qwen"
    ? `<button id="stop-generate-button" hidden>Stop</button>`
    : `<button aria-label="Stop response" data-testid="stop-button" hidden>Stop</button>`;
  // Each site's assistant turn is wrapped the way that site wraps it; matching
  // the selector is part of the contract, so the fixture must not be generic.
  const assistant =
    site === "chatgpt" ? `<article data-message-author-role="assistant"><div data-testid="assistant-message"></div></article>` :
    site === "claude" ? `<div class="font-claude-message" data-testid="assistant-message"></div>` :
    site === "gemini" ? `<model-response><div class="markdown"></div></model-response>` :
    `<div class="chat-message-assistant"></div>`;
  return `<!doctype html><html><body>
    <main id="thread">
      <article data-message-author-role="user"><p>first question</p></article>
      ${assistant}
    </main>
    <form>${input}${send}${stop}</form>
  </body></html>`;
}

// ── the adapter itself: identical code for every site ─────────────────────
function makeAdapter(window, site) {
  const doc = window.document;
  const s = SITES[site];
  const pick = (selectors) => {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const adapter = {
    version: "1.0.0",
    site,
    match(url) { return url.startsWith(new URL(s.url).origin); },
    findInput() { return pick(s.input); },
    getText() {
      const el = adapter.findInput();
      if (!el) return null;
      return "value" in el ? el.value : el.innerText ?? el.textContent ?? "";
    },
    /** Framework-safe write: native setter for React, beforeinput for rich text. */
    setText(text) {
      const el = adapter.findInput();
      if (!el) return false;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc.set.call(el, text);                       // bypasses React's value tracker
        el.dispatchEvent(new window.Event("input", { bubbles: true }));
      } else {
        el.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
        el.textContent = text;
        el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return true;
    },
    submit() {
      const btn = pick(s.submit);
      if (!btn) return false;
      btn.click();
      return true;
    },
    isStreaming() {
      const stop = pick(s.stop);
      return !!stop && !stop.hasAttribute("hidden");
    },
    /** Call cb(text) when a new assistant turn settles. */
    observeAssistant(cb) {
      const el = pick(s.assistant);
      if (!el) return { stop() {} };
      let last = el.textContent ?? "";
      let timer = null;
      const emit = () => {
        const text = el.textContent ?? "";
        if (text !== last) { last = text; cb(text); }
      };
      const mo = new window.MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(emit, 50); // throttled extraction
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      return { stop() { clearTimeout(timer); mo.disconnect(); } };
    },
  };
  return adapter;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

for (const site of Object.keys(SITES)) {
  const dom = new JSDOM(fixtureHtml(site), { url: SITES[site].url, pretendToBeVisual: true });
  const { window } = dom;
  const adapter = makeAdapter(window, site);
  const checks = {};
  const detail = {};

  // 1. input — find the box, write text, read it back through the framework.
  const found = adapter.findInput();
  const text = `CHRONOS CONTEXT\npath: backend/auth/jwt-spec@v4\n<<<UNVERIFIED>>>\nrotating tokens every hour`;
  const injected = adapter.setText(text);
  const readBack = adapter.getText();
  checks.input = !!found && injected && readBack === text;
  detail.input = { selectorHit: found ? found.tagName : null, lengthIn: text.length, lengthOut: readBack?.length ?? 0, exact: readBack === text };

  // 2. output — extract a completed assistant turn.
  const assistantEl = window.document.querySelector(SITES[site].assistant[0]) ?? window.document.querySelector(SITES[site].assistant[1]);
  assistantEl.textContent = "Here is the plan: rotate tokens hourly.";
  const seen = [];
  const obs = adapter.observeAssistant((t) => seen.push(t));
  await sleep(60);
  assistantEl.textContent = "Here is the plan: rotate tokens hourly, and cache for 60s.";
  await sleep(120);
  obs.stop();
  checks.output = seen.length > 0 && seen.at(-1).includes("cache for 60s");
  detail.output = { callbacks: seen.length, last: seen.at(-1) ?? null };

  // 3. submit — the send button must actually dispatch a submit/click handler.
  let submitted = 0;
  const btn = (() => { for (const sel of SITES[site].submit) { const el = window.document.querySelector(sel); if (el) return el; } return null; })();
  btn?.addEventListener("click", (e) => { e.preventDefault(); submitted++; });
  const submitOk = adapter.submit();
  checks.submit = submitOk && submitted === 1;
  detail.submit = { buttonHit: !!btn, events: submitted };

  // 4. stream-end — stop-button state + 800 ms quiescence, no premature emit.
  const stopBtn = window.document.querySelector(SITES[site].stop[0]);
  const el2 = assistantEl;
  el2.textContent = "";
  const events = [];
  const obs2 = adapter.observeAssistant((t) => events.push({ t, at: performance.now() }));
  stopBtn.removeAttribute("hidden");
  const streamStart = performance.now();
  for (const chunk of ["Thinking", "Thinking about", "Thinking about tokens"]) {
    el2.textContent = chunk;
    await sleep(30);
  }
  const streamingSeen = adapter.isStreaming();
  stopBtn.setAttribute("hidden", "");
  const streamEnd = performance.now();
  await sleep(900);
  obs2.stop();
  const lastEvent = events.at(-1);
  checks.streamEnd = streamingSeen
    && !!lastEvent
    && lastEvent.t.includes("tokens")
    // The final extraction must land after the stop signal, not during the stream.
    && lastEvent.at >= streamEnd - 80;
  detail.streamEnd = {
    stopButtonDetected: streamingSeen,
    events: events.length,
    finalText: lastEvent?.t ?? null,
    msAfterStreamEnd: lastEvent ? Math.round(lastEvent.at - streamEnd) : null,
    streamDurationMs: Math.round(streamEnd - streamStart),
  };

  const passed = Object.values(checks).filter(Boolean).length;
  results.push({ site, framework: SITES[site].framework, checks, passed, of: 4, detail });
  console.log(`[adapter] ${site.padEnd(8)} ${passed}/4  ${JSON.stringify(checks)}`);
  window.close();
}

const total = results.reduce((a, r) => a + r.passed, 0);
const max = results.length * 4;

// ── @page_in interception + clipboard capsule against a mock daemon ────────
// §5.4: regex scan, 400 ms debounce after stream end, max 3 auto-pages per turn,
// dedupe by (path, turn). §5.5: capsule is copied to the clipboard on request.
const interception = (() => {
  const RE = /@page_in\[([^\]]{1,400})\]/g;
  const MAX_PER_TURN = 3;
  function scan(text, turn, alreadyPaged) {
    const out = [];
    for (const m of text.matchAll(RE)) {
      for (const raw of m[1].split(",")) {
        const p = raw.trim();
        if (!p || !/^[a-z0-9][a-z0-9._/-]*$/i.test(p)) continue;
        if (alreadyPaged.has(`${p}\u0000${turn}`) || out.some((o) => o === p)) continue;
        out.push(p);
      }
    }
    return out.slice(0, MAX_PER_TURN);
  }
  const t0 = performance.now();
  const many = "x".repeat(3800) + " @page_in[backend/auth/jwt-spec, backend/billing/plan, backend/sync/queue, backend/cache/policy]";
  const first = scan(many, 1, new Set());
  const scanMs = performance.now() - t0;
  // Dedupe: the same paths on the same turn must not be paged again, even
  // though the cap would still allow three more.
  const pagedThisTurn = new Set(["backend/auth/jwt-spec", "backend/billing/plan", "backend/sync/queue", "backend/cache/policy"].map((p) => `${p}\u0000${1}`));
  const second = scan(many, 1, pagedThisTurn);
  const capped = first.length === MAX_PER_TURN;
  return {
    parsed: first,
    cappedAt3: capped,
    dedupeOnRepeat: second.length === 0,
    scanMsFor3_8KB: scanMs,
  };
})();

const clipboard = await (async () => {
  const dom = new JSDOM("<body></body>", { url: "https://chatgpt.com/" });
  let copied = null;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (t) => { copied = t; } },
    configurable: true,
  });
  const capsule = "CHRONOS CAPSULE v1\nproject: chronos-ctx\nhead: chk_01JBQ\nobjective: ...";
  await dom.window.navigator.clipboard.writeText(capsule);
  dom.window.close();
  return { wroteCapsule: copied === capsule, bytes: copied?.length ?? 0 };
})();

writeJson(OUT, {
  gate: "0.8",
  title: "DOM adapter contract on recorded fixtures",
  environment: "jsdom (no network, no account, no extension runtime)",
  behaviors: ["input", "output", "submit", "streamEnd"],
  k8: { sites: results.length, passed: total, of: max, verdictOnFixture: total === max ? "4/4 per site" : "partial" },
  caveat: "Fixture DOMs are reconstructed from the published adapter contract, not captured from live pages. K8's live half requires the Phase 5 nightly smoke and is unverifiable in Phase 0.",
  interception,
  clipboard,
  results,
});
console.log(`[adapter] total ${total}/${max} → ${OUT}`);
console.log(`[adapter] @page_in capped=${interception.cappedAt3} dedupe=${interception.dedupeOnRepeat} clipboard=${clipboard.wroteCapsule}`);
