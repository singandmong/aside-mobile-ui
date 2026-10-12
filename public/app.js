const state = { host: null, tab: null, session: null, tabs: [], sessions: [], token: "", sessionTimer: null };
const $ = (id) => document.getElementById(id);
const status = (text, bad = false) => { $("status").textContent = text; $("status").className = `status${bad ? " bad" : ""}`; };
const request = async (path, options) => {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(options?.headers ?? {}) } });
  if (!response.ok) {
    if (response.status === 401) {
      $("auth-panel")?.removeAttribute("hidden");
      throw new Error("인증 토큰이 필요합니다");
    }
    throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  }
  return response.json();
};
const hostPath = (suffix) => `/api/hosts/${encodeURIComponent(state.host.id)}${suffix}`;

function renderHosts(hosts) {
  $("hosts").replaceChildren(...hosts.map((host) => {
    const button = document.createElement("button");
    button.className = `host ${state.host?.id === host.id ? "selected" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = host.deviceName;
    button.querySelector("span").textContent = `${host.platform} · ${host.online ? "온라인" : "오프라인"}`;
    button.disabled = !host.online || !host.remoteControlEnabled;
    button.onclick = () => selectHost(host);
    return button;
  }));
}

function renderTabs() {
  $("tabs").replaceChildren(...state.tabs.map((tab) => {
    const button = document.createElement("button");
    button.className = state.tab?.targetId === tab.targetId ? "selected" : "";
    button.textContent = tab.title || tab.url;
    button.onclick = () => { state.tab = tab; renderTabs(); $("show-dom").disabled = false; $("capture").disabled = false; $("dom-view").className = "dom-view empty"; $("dom-view").textContent = "필요할 때만 탭 내용을 불러옵니다"; };
    return button;
  }));
}

function renderSessions() {
  $("sessions").replaceChildren(...state.sessions.map((session) => {
    const button = document.createElement("button");
    button.textContent = `${session.title || "제목 없음"} · ${session.status || "상태 없음"}`;
    button.onclick = async () => {
      state.session = session;
      try { $("messages").textContent = JSON.stringify(await request(hostPath(`/sessions/${encodeURIComponent(session.id)}/messages`)), null, 2); }
      catch (error) { status(error.message, true); }
    };
    return button;
  }));
}

async function capture() {
  if (!state.host || !state.tab) return;
  try {
    const image = await request(hostPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/screenshot`), { method: "POST", body: "{}" });
    $("frame").className = "frame";
    $("frame").replaceChildren(Object.assign(new Image(), { src: `data:${image.mime};base64,${image.data}`, alt: "현재 Aside 브라우저 화면" }));
    status(`${state.host.deviceName} · ${state.tab.title || "탭"}`);
  } catch (error) { status(`화면을 가져오지 못했습니다: ${error.message}`, true); }
}

async function action(body) {
  if (!state.host || !state.tab) return status("먼저 브라우저 탭을 선택하세요", true);
  try { await request(hostPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/action`), { method: "POST", body: JSON.stringify(body) }); await capture(); }
  catch (error) { status(`동작을 보낼 수 없습니다: ${error.message}`, true); }
}

async function showDom() {
  if (!state.host || !state.tab) return;
  try {
    const dom = await request(hostPath(`/tabs/${encodeURIComponent(state.tab.targetId)}/dom`));
    const view = $("dom-view");
    view.className = "dom-view";
    view.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = dom.title;
    view.append(heading);
    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = dom.url;
    view.append(meta);
    const text = document.createElement("pre");
    text.textContent = dom.text;
    view.append(text);
    for (const link of dom.links) {
      const row = document.createElement("p");
      row.textContent = `링크: ${link.text} → ${link.href}`;
      view.append(row);
    }
    status("탭 내용을 불러왔습니다");
  } catch (error) { status(`탭 내용을 가져오지 못했습니다: ${error.message}`, true); }
}

async function submitPrompt(prompt) {
  if (!state.host || !prompt) return;
  const path = state.session ? `/sessions/${encodeURIComponent(state.session.id)}/resume` : "/exec";
  try {
    await request(hostPath(path), { method: "POST", body: JSON.stringify({ prompt }) });
    $("prompt").value = "";
    status("Aside에 전송했습니다");
    [state.sessions] = await Promise.all([request(hostPath("/sessions"))]);
    renderSessions();
  } catch (error) { status(`작업을 보내지 못했습니다: ${error.message}`, true); }
}

async function refreshSessions() {
  if (!state.host) return;
  try {
    state.sessions = await request(hostPath("/sessions"));
    renderSessions();
  } catch (error) { status(`세션 갱신 실패: ${error.message}`, true); }
}

async function selectHost(host) {
  clearInterval(state.sessionTimer); state.sessionTimer = null;
  state.host = host; state.tab = null; state.session = null; renderHosts([host]); status("상태를 가져오는 중…");
  try {
    [state.tabs, state.sessions] = await Promise.all([request(hostPath("/tabs")), request(hostPath("/sessions"))]);
    $("auth-panel").hidden = true;
    renderTabs(); renderSessions(); state.sessionTimer = setInterval(refreshSessions, 3000);
  } catch (error) { status(`Aside 연결 실패: ${error.message}`, true); }
}

async function load() {
  try { const hosts = await request("/api/hosts"); renderHosts(hosts); const first = hosts.find((host) => host.online && host.remoteControlEnabled); if (first) await selectHost(first); else status("온라인 상태의 원격 Aside 호스트가 없습니다", true); }
  catch (error) { status(`서버 연결 실패: ${error.message}`, true); }
}

$("refresh").onclick = load;
document.querySelectorAll("[data-action]").forEach((button) => button.onclick = () => action(button.dataset.action === "scroll" ? { action: "scroll", dx: 0, dy: Number(button.dataset.dy) } : { action: "key", key: button.dataset.key }));
$("type-form").onsubmit = async (event) => { event.preventDefault(); const text = $("text").value; if (!text) return; await action({ action: "type", text }); $("text").value = ""; };
$("prompt-form").onsubmit = async (event) => { event.preventDefault(); await submitPrompt($("prompt").value.trim()); };
$("stop").onclick = async () => {
  if (!state.host || !state.session) return status("중지할 작업을 선택하세요", true);
  try { await request(hostPath(`/sessions/${encodeURIComponent(state.session.id)}/stop`), { method: "POST" }); status("중지 요청을 보냈습니다"); }
  catch (error) { status(`중지하지 못했습니다: ${error.message}`, true); }
};
$("show-dom").onclick = showDom;
$("capture").onclick = capture;
$("auth-form").onsubmit = async (event) => { event.preventDefault(); state.token = $("token").value; await load(); };
$("close-session").onclick = () => { state.session = null; $("messages").textContent = "작업을 선택하세요"; status("세션 선택을 닫았습니다"); };
status("연결 중…");
load();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=4").catch(() => {});
