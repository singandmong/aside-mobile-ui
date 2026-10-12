const $ = (id) => document.getElementById(id);
const view = $("view");

const ERROR_TEXT = {
  environment_offline: "실행 환경이 오프라인입니다",
  environment_timeout: "실행 환경 응답이 늦습니다",
  aside_unavailable: "Aside가 응답하지 않습니다",
  bad_request: "잘못된 요청입니다",
  not_found: "찾을 수 없습니다",
};

const state = {
  token: localStorage.getItem("asideMobileToken") || "",
  environments: null,
  env: null,
  sessions: [],
  session: null,
  messages: [],
  pending: [],
  tab: null,
  timer: null,
};

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function api(path, options = {}) {
  const headers = {};
  if (options.body) headers["content-type"] = "application/json";
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let response;
  try { response = await fetch(path, { ...options, headers }); }
  catch { throw new ApiError("network", "서버에 연결할 수 없습니다"); }
  if (!(response.headers.get("content-type") || "").includes("application/json")) throw new ApiError("not_aside", "Aside Mobile 서버 응답이 아닙니다. 주소와 포트를 확인하세요");
  const body = await response.json();
  if (response.status === 401) { openAuth(); throw new ApiError("unauthorized", "인증이 필요합니다"); }
  if (!response.ok) throw new ApiError(body.error || "error", ERROR_TEXT[body.error] || `요청 실패 (${response.status})`);
  return body;
}

const envPath = (suffix = "") => `/api/environments/${encodeURIComponent(state.env.id)}${suffix}`;

// ---------- small DOM helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function banner(text, tone = "") {
  const node = $("banner");
  if (!text) { node.hidden = true; return; }
  node.textContent = text;
  node.className = `banner ${tone}`;
  node.hidden = false;
}

function header({ title, subtitle, back, tools }) {
  $("title").textContent = title;
  $("subtitle").textContent = subtitle || "";
  $("back").hidden = !back;
  $("back").onclick = () => { if (back) location.hash = back; };
  $("tools-btn").hidden = !tools;
}

function timeAgo(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

function statusChip(status) {
  const value = (status || "").toLowerCase();
  const tone = /run|work|busy|stream/.test(value) ? "running" : /wait|approv|question|suspend|block/.test(value) ? "attention" : "";
  const label = { idle: "대기", running: "실행 중", interrupted: "중단됨", suspended: "일시정지" }[value] || status || "알 수 없음";
  return el("span", { class: `chip ${tone}` }, label);
}

const platformGlyph = (platform) => ({ macos: "Mac", windows: "PC", linux: "Linux" }[platform] || "?");
function stopPolling() { clearInterval(state.timer); state.timer = null; }
function poll(fn, ms) {
  stopPolling();
  let inFlight = false;
  state.timer = setInterval(async () => {
    if (document.hidden || inFlight) return;
    inFlight = true;
    try { await fn(); banner(""); } catch (error) { if (error.code !== "unauthorized") banner(error.message, "bad"); } finally { inFlight = false; }
  }, ms);
}

// ---------- routing ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "e" || !parts[1]) return { envId: null };
  return { envId: parts[1], isNew: parts[2] === "new", sessionId: parts[2] === "s" ? parts[3] : null };
}

async function loadEnvironments() {
  state.environments = await api("/api/environments");
  return state.environments;
}

async function render() {
  stopPolling();
  banner("");
  $("composer").hidden = true;
  const { envId, isNew, sessionId } = route();
  try {
    if (!envId) return await renderEnvironments();
    if (!state.environments || !state.environments.some((env) => env.id === envId)) await loadEnvironments();
    state.env = state.environments.find((env) => env.id === envId) || null;
    if (!state.env) { location.hash = "#/"; return; }
    localStorage.setItem("asideMobileLastEnv", state.env.id);
    if (isNew || sessionId) return await renderChat(sessionId);
    return await renderSessions();
  } catch (error) {
    if (error.code !== "unauthorized") showError(error);
  }
}

/** replaceChildren() stringifies null ("null"); drop absent optional nodes instead. */
function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
}

function showError(error) {
  view.replaceChildren(el("div", { class: "empty" }, el("p", {}, error.message), el("button", { type: "button", onclick: render }, "다시 시도")));
}

// ---------- view: environments ----------
const CONNECTION_LABEL = { local: "이 컴퓨터", "aside-remote": "Aside 원격 · 느림", relay: "연결됨" };

async function renderEnvironments() {
  header({ title: "Aside", subtitle: "실행 환경 선택" });
  view.replaceChildren(el("p", { class: "empty" }, "실행 환경을 찾는 중…"));
  const [environments, health] = await Promise.all([loadEnvironments(), fetch("/api/health").then((response) => response.json()).catch(() => ({}))]);
  state.relay = Boolean(health.relay);
  const last = localStorage.getItem("asideMobileLastEnv");
  const connect = state.relay ? el("button", { type: "button", class: "new-task", onclick: openPairing }, "＋ 다른 컴퓨터 연결") : null;
  if (environments.length === 0) {
    fill(view, el("div", { class: "empty" }, el("p", {}, "연결된 실행 환경이 없습니다."), el("p", { class: "muted" }, "Mac에서 Aside를 실행하고 설정 › 개발자 › 원격 제어를 켜세요.")), connect);
    return;
  }
  const rank = { local: 0, relay: 1, "aside-remote": 2 };
  const sorted = [...environments].sort((a, b) => Number(b.online) - Number(a.online) || rank[a.connection] - rank[b.connection] || Number(b.id === last) - Number(a.id === last));
  fill(view,
    el("p", { class: "section-title" }, "Aside를 실행할 컴퓨터"),
    el("div", { class: "list" }, sorted.map((env) => el("button", {
      type: "button",
      class: `card${env.capabilities.sessions ? "" : " disabled"}`,
      onclick: () => { if (env.capabilities.sessions) location.hash = `#/e/${encodeURIComponent(env.id)}`; else banner("이 환경은 오프라인이거나 원격 제어가 꺼져 있습니다", "bad"); },
    },
      el("span", { class: "glyph" }, platformGlyph(env.platform)),
      el("span", { class: "body" },
        el("div", { class: "name" }, env.label),
        el("div", { class: "meta" },
          el("span", { class: `dot${env.online ? " on" : ""}` }),
          env.online ? "온라인" : "오프라인",
          el("span", { class: "chip" }, CONNECTION_LABEL[env.connection] ?? env.connection),
          env.id === last ? el("span", { class: "chip" }, "최근") : null)),
      el("span", { class: "chev" }, "›")))),
    connect ? el("div", { class: "row" }, connect) : null,
  );
}

// ---------- pairing (relay hub only) ----------
async function openPairing() {
  const dialog = $("pair");
  if (!dialog.open) dialog.showModal();
  const body = $("pair-body");
  body.replaceChildren(el("p", { class: "muted" }, "연결 코드를 만드는 중…"));
  drawConnectors();
  try {
    const { code, expiresAt } = await api("/api/pairing", { method: "POST" });
    const command = `./bin/install-connector.sh --hub ${location.origin} --code ${code}`;
    const remaining = el("span", {});
    const tick = () => {
      const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      remaining.textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 후 만료` : "만료됨 · 다시 열어 새 코드를 만드세요";
      return seconds;
    };
    tick();
    body.replaceChildren(
      el("p", { class: "muted" }, "연결할 Mac에서 aside-mobile-ui를 받은 뒤, 폴더 안에서 아래 명령을 실행하세요. 코드는 한 번만 쓸 수 있습니다."),
      el("p", { class: "pair-code" }, code),
      el("pre", { class: "command" }, command),
      el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: () => navigator.clipboard?.writeText(command).then(() => banner("명령을 복사했습니다", "ok")) }, "명령 복사"), el("span", { class: "muted" }, remaining)),
    );
    const known = new Set((state.environments || []).map((env) => env.id));
    const timer = setInterval(async () => {
      if (!dialog.open || tick() === 0) { clearInterval(timer); return; }
      const environments = await api("/api/environments").catch(() => null);
      const added = environments?.find((env) => env.connection === "relay" && env.online && !known.has(env.id));
      if (added) { clearInterval(timer); dialog.close(); banner(`${added.label} 연결됨`, "ok"); state.environments = environments; render(); }
    }, 3000);
  } catch (error) { body.replaceChildren(el("p", { class: "muted" }, error.message)); }
}

async function drawConnectors() {
  const list = $("connector-list");
  try {
    const connectors = await api("/api/connectors");
    list.replaceChildren(...(connectors.length ? connectors.map((connector) => el("div", { class: "card" },
      el("span", { class: "body" }, el("div", { class: "name" }, connector.label), el("div", { class: "meta" }, el("span", { class: `dot${connector.online ? " on" : ""}` }), el("span", {}, connector.online ? "온라인" : "오프라인"), el("span", {}, `${timeAgo(connector.createdAt)} 연결`))),
      el("button", { type: "button", class: "danger", onclick: async () => {
        if (!confirm(`${connector.label} 연결을 해제할까요? 다시 쓰려면 새로 연결해야 합니다.`)) return;
        await api(`/api/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" }).catch((error) => banner(error.message, "bad"));
        state.environments = null;
        drawConnectors();
      } }, "해제"))) : [el("p", { class: "muted" }, "아직 연결된 컴퓨터가 없습니다")]));
  } catch (error) { list.replaceChildren(el("p", { class: "muted" }, error.message)); }
}

$("pair").addEventListener("click", (event) => { if (event.target.closest("[data-close]")) { $("pair").close(); render(); } });

// ---------- view: sessions ----------
async function renderSessions() {
  header({ title: state.env.label, subtitle: `${platformGlyph(state.env.platform)} · ${state.env.online ? "온라인" : "오프라인"}`, back: "#/", tools: state.env.capabilities.browserTabs });
  view.replaceChildren(el("p", { class: "empty" }, "세션을 불러오는 중…"));
  const draw = async () => {
    state.sessions = await api(envPath("/sessions"));
    view.replaceChildren(
      el("button", { type: "button", class: "primary new-task", onclick: () => { location.hash = `#/e/${encodeURIComponent(state.env.id)}/new`; } }, "＋ 새 작업"),
      el("p", { class: "section-title" }, "최근 세션"),
      state.sessions.length === 0
        ? el("p", { class: "empty" }, "세션이 없습니다")
        : el("div", { class: "list" }, state.sessions.map((session) => el("button", {
          type: "button",
          class: "card",
          onclick: () => { location.hash = `#/e/${encodeURIComponent(state.env.id)}/s/${encodeURIComponent(session.id)}`; },
        },
          el("span", { class: "body" },
            el("div", { class: "name" }, session.title || "제목 없음"),
            el("div", { class: "meta" }, statusChip(session.status), timeAgo(session.updatedAt))),
          el("span", { class: "chev" }, "›")))),
    );
  };
  await draw();
  poll(draw, 5000);
}

// ---------- view: chat ----------
async function renderChat(sessionId) {
  state.session = sessionId ? (state.sessions.find((session) => session.id === sessionId) ?? { id: sessionId, title: "", status: "" }) : null;
  state.messages = [];
  state.messagesLoaded = false;
  header({ title: sessionId ? "세션" : "새 작업", subtitle: state.env.label, back: `#/e/${encodeURIComponent(state.env.id)}`, tools: state.env.capabilities.browserTabs });
  $("composer").hidden = !state.env.capabilities.prompts;
  $("prompt").placeholder = sessionId ? "후속 요청 보내기" : "Aside에게 새 작업 요청하기";
  drawChat();
  if (!sessionId) { $("prompt").focus(); return; }
  try { await refreshChat(); } catch (error) { state.messagesLoaded = true; drawChat(); banner(error.message, "bad"); }
  poll(refreshChat, 3000);
}

async function refreshChat() {
  if (!state.session) return;
  const [messages, sessions] = await Promise.all([api(envPath(`/sessions/${encodeURIComponent(state.session.id)}/messages`)), api(envPath("/sessions"))]);
  state.messages = messages;
  state.messagesLoaded = true;
  const summary = sessions.find((session) => session.id === state.session.id);
  if (summary) state.session = summary;
  const userTexts = messages.filter((message) => message.role === "user").map((message) => message.text.trim());
  state.pending = state.pending.filter((item) => item.sessionId !== state.session.id || item.state === "failed" || !userTexts.includes(item.text.trim()));
  drawChat();
}

function drawChat() {
  if (state.session) $("title").textContent = state.session.title || "세션";
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 80;
  const pending = state.pending.filter((item) => item.sessionId === (state.session?.id ?? null));
  const bar = state.session
    ? el("div", { class: "session-bar" }, statusChip(state.session.status), el("span", { class: "grow" }),
      state.env.capabilities.stop ? el("button", { type: "button", class: "danger", onclick: stopSession }, "중지") : null)
    : el("p", { class: "muted" }, `${state.env.label}에서 새 Aside 작업을 시작합니다.`);
  const bubbles = state.messages.map((message) => el("div", { class: `bubble ${message.role}` }, message.text));
  const pendingBubbles = pending.map((item) => el("div", { class: "bubble user pending" }, item.text,
    el("span", { class: "state" }, { sending: "보내는 중…", sent: "전송됨 · Aside 처리 대기", failed: "전송 실패" }[item.state])));
  const emptyText = !state.messagesLoaded ? "메시지를 불러오는 중…" : "표시할 대화가 없습니다";
  const empty = state.session && state.messages.length === 0 && pending.length === 0 ? el("p", { class: "empty" }, emptyText) : null;
  fill(view, bar, el("div", { class: "chat" }, bubbles, pendingBubbles), empty);
  if (atBottom || pending.length) view.scrollTop = view.scrollHeight;
}

async function sendPrompt(text) {
  const item = { text, sessionId: state.session?.id ?? null, state: "sending" };
  state.pending.push(item);
  drawChat();
  try {
    const result = state.session
      ? await api(envPath(`/sessions/${encodeURIComponent(state.session.id)}/resume`), { method: "POST", body: JSON.stringify({ prompt: text }) })
      : await api(envPath("/exec"), { method: "POST", body: JSON.stringify({ prompt: text }) });
    item.state = "sent";
    if (!state.session) {
      if (result.sessionId) {
        item.sessionId = result.sessionId;
        location.hash = `#/e/${encodeURIComponent(state.env.id)}/s/${encodeURIComponent(result.sessionId)}`;
        return;
      }
      banner("작업을 시작했습니다. 세션 목록에서 확인하세요", "ok");
      location.hash = `#/e/${encodeURIComponent(state.env.id)}`;
      return;
    }
    drawChat();
  } catch (error) {
    item.state = "failed";
    drawChat();
    banner(error.message, "bad");
  }
}

async function stopSession() {
  if (!state.session || !confirm("이 Aside 작업을 중지할까요?")) return;
  try {
    await api(envPath(`/sessions/${encodeURIComponent(state.session.id)}/stop`), { method: "POST" });
    banner("중지 요청을 보냈습니다", "ok");
    await refreshChat();
  } catch (error) { banner(error.message, "bad"); }
}

// ---------- composer ----------
const prompt = $("prompt");
prompt.addEventListener("input", () => { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 140)}px`; });
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text) return;
  prompt.value = "";
  prompt.style.height = "auto";
  sendPrompt(text);
});

// ---------- browser tools ----------
async function openTools() {
  const dialog = $("tools");
  state.tab = null;
  $("tab-panel").hidden = true;
  $("tool-output").replaceChildren();
  $("tab-list").replaceChildren(el("p", { class: "muted" }, "탭을 불러오는 중…"));
  dialog.showModal();
  try {
    const tabs = await api(envPath("/tabs"));
    $("tab-list").replaceChildren(...(tabs.length ? tabs.map((tab) => el("button", {
      type: "button",
      class: "card tab-item",
      onclick: (event) => {
        state.tab = tab;
        for (const node of $("tab-list").children) node.classList.toggle("selected", node === event.currentTarget);
        $("tab-panel").hidden = false;
        $("tool-output").replaceChildren();
      },
    }, el("span", { class: "body" }, el("div", { class: "name" }, tab.title || "제목 없음"), el("div", { class: "meta" }, hostOf(tab.url))))) : [el("p", { class: "muted" }, "열린 탭이 없습니다")]));
  } catch (error) { $("tab-list").replaceChildren(el("p", { class: "muted" }, error.message)); }
}

function hostOf(url) { try { return new URL(url).host || url; } catch { return url || ""; } }

async function toolAction(body) {
  if (!state.tab) return;
  try {
    await api(envPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/action`), { method: "POST", body: JSON.stringify(body) });
    $("tool-output").replaceChildren(el("p", { class: "muted" }, "전송됨"));
  } catch (error) { $("tool-output").replaceChildren(el("p", { class: "muted" }, error.message)); }
}

async function showDom() {
  $("tool-output").replaceChildren(el("p", { class: "muted" }, "내용을 불러오는 중…"));
  try {
    const dom = await api(envPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/dom`));
    fill($("tool-output"),
      el("h3", {}, dom.title || "제목 없음"),
      el("p", { class: "muted" }, dom.url),
      el("pre", {}, dom.text || "(본문 없음)"),
      dom.links.length ? el("p", { class: "section-title" }, "링크") : null,
      ...dom.links.slice(0, 40).map((link) => el("p", { class: "muted" }, `${link.text || "(텍스트 없음)"} → ${link.href}`)),
    );
  } catch (error) { $("tool-output").replaceChildren(el("p", { class: "muted" }, error.message)); }
}

async function showScreenshot() {
  $("tool-output").replaceChildren(el("p", { class: "muted" }, "화면을 가져오는 중…"));
  try {
    const image = await api(envPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/screenshot`), { method: "POST", body: "{}" });
    $("tool-output").replaceChildren(el("img", { src: `data:${image.mime};base64,${image.data}`, alt: "Aside 브라우저 화면" }));
  } catch (error) { $("tool-output").replaceChildren(el("p", { class: "muted" }, error.message)); }
}

$("tools-btn").onclick = openTools;
$("tools").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.hasAttribute("data-close")) $("tools").close();
  else if (target.dataset.tool === "dom") showDom();
  else if (target.dataset.tool === "shot") showScreenshot();
  else if (target.dataset.key) toolAction({ action: "key", key: target.dataset.key });
  else if (target.dataset.scroll) toolAction({ action: "scroll", dx: 0, dy: Number(target.dataset.scroll) });
});
$("type-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("type-text").value;
  if (!text) return;
  $("type-text").value = "";
  toolAction({ action: "type", text });
});

// ---------- auth ----------
function openAuth() {
  const dialog = $("auth");
  if (!dialog.open) dialog.showModal();
}
$("auth-form").addEventListener("submit", () => {
  state.token = $("token").value.trim();
  if (state.token) localStorage.setItem("asideMobileToken", state.token); else localStorage.removeItem("asideMobileToken");
  render();
});

// ---------- boot ----------
$("refresh").onclick = () => { state.environments = null; render(); };
window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden && route().envId) render(); });
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=6").catch(() => {});
