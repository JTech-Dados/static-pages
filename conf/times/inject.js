// ============================================================
// Extensões do painel do File Browser, injetadas pelo NGINX
// (sub_filter) no HTML do /admin:
//
//   1. Item "Acessos" no menu lateral (só admins), com o número de pedidos
//      de acesso pendentes (login Microsoft)
//   0. Na barra superior: quem está logado, o time e o papel (Admin/Editor),
//      e, para o admin, um aviso amarelo com os pedidos pendentes
//   2. Colunas na listagem de arquivos:
//        "Time"         time da pasta
//        "Alterado por" último usuário que enviou/editou/renomeou,
//                       lido de <pasta>/.autoria (gravado pelo hook
//                       sp-autoria). Data e hora no tooltip.
//      Só para admins: membros ficam com "ocultar dotfiles" ligado
//      (não podem ler nem apagar .autoria/.time.json do time).
//
// O File Browser é uma SPA: menu e lista são recriados ao navegar,
// então um MutationObserver reaplica tudo (de forma idempotente).
// ============================================================
(function () {
  "use strict";

  // Prefixo público do app (ex.: "/pages"); vazio na raiz. O painel vive
  // em <prefixo>/admin/, então o prefixo é o que vem antes de "/admin".
  const BASE = location.pathname.replace(/\/admin(\/.*)?$/, "");
  const API = BASE + "/admin/api";
  const CACHE_MS = 3000;
  const dirCache = new Map();   // caminho -> { at, map }
  let teams = null;             // nome da pasta de 1º nível -> nome do time
  let teamsAt = 0;

  // ---------- sessão ----------
  function session() {
    try {
      const token = localStorage.getItem("jwt");
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return { token, user: payload.user || null, admin: Boolean(payload.user && payload.user.perm && payload.user.perm.admin) };
    } catch (_) {
      return null;
    }
  }

  const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

  // caminho atual da listagem, relativo à raiz do usuário: "" ou "a/b"
  function currentPath() {
    const m = decodeURIComponent(location.pathname.slice(BASE.length)).match(/^\/admin\/files\/?(.*?)\/?$/);
    return m ? m[1] : null;
  }

  // ---------- 1. menu ----------
  function addMenuItem(s) {
    const nav = document.querySelector("nav");
    if (!nav || nav.querySelector("[data-sp-times]") || !s.admin) return;
    const settings = Array.from(nav.querySelectorAll(".action")).find((b) =>
      /settings/.test((b.querySelector("i") || {}).textContent || ""));
    if (!settings) return;

    const link = document.createElement("a");
    link.className = "action";
    link.href = BASE + "/admin/times";
    link.dataset.spTimes = "";
    link.title = "Acessos e times";
    link.setAttribute("aria-label", "Acessos e times");
    const icon = document.createElement("i");
    icon.className = "material-icons";
    icon.textContent = "groups";
    const label = document.createElement("span");
    label.textContent = "Acessos";
    const badge = document.createElement("span");
    badge.className = "sp-badge";
    badge.dataset.spBadge = "";
    badge.hidden = true;
    link.append(icon, label, badge);
    settings.parentNode.insertBefore(link, settings);
    paintPending();
  }

  // ---------- 0. barra superior: quem sou, time, papel, pedidos pendentes ----------
  let me = null;            // usuário logado (GET entra/me): nome, papel, time
  let meTeam = null;        // nome do time do membro
  let entraOn = null;       // login Microsoft ligado? (lido uma vez)
  let pending = 0;
  let pendingAt = 0;

  const span = (cls) => { const n = document.createElement("span"); n.className = cls; return n; };
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  // O File Browser esconde o escopo (time) de quem consulta a si mesmo; o sp-auth responde
  // depois de conferir o token. Se não responder, a barra mostra só o papel.
  let meBusy = null;
  function loadMe(s) {
    if (me || !s.user) return Promise.resolve();
    if (!meBusy) {
      meBusy = fetch(BASE + "/admin/entra/me", { headers: { "X-Auth": s.token }, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) { me = { username: d.nome || d.usuario, email: d.usuario }; meTeam = d.timeNome || d.time || ""; } })
        .catch(() => { /* sem nome na barra */ })
        .finally(() => { meBusy = null; });
    }
    return meBusy;
  }

  function addWhoChip(s) {
    const header = document.querySelector("header");
    if (!header || !s.user) return;
    let chip = header.querySelector("[data-sp-chip]");
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "sp-chip";
      chip.dataset.spChip = "";
      const pend = document.createElement("a");
      pend.className = "sp-chip-pending";
      pend.dataset.spPending = "";
      pend.href = BASE + "/admin/times#acessos";
      pend.hidden = true;
      chip.append(span("sp-chip-user"), span("sp-chip-team"), span("sp-chip-role"), pend);
      const search = header.querySelector("#search");
      header.insertBefore(chip, search ? search.nextSibling : null);
      paintPending();
    }
    const perm = s.user.perm || {};
    const who = chip.querySelector(".sp-chip-user");
    setText(who, (me && me.username) || "");
    if (me && me.email) who.title = me.email;
    setText(chip.querySelector(".sp-chip-team"), s.admin ? "Todos os times" : meTeam || "");
    setText(chip.querySelector(".sp-chip-role"), s.admin ? "Admin" : perm.create || perm.modify ? "Editor" : "Leitor");
  }

  function paintPending() {
    document.querySelectorAll("[data-sp-badge]").forEach((b) => { setText(b, pending ? String(pending) : ""); b.hidden = !pending; });
    document.querySelectorAll("[data-sp-pending]").forEach((a) => {
      setText(a, pending === 1 ? "1 pedido de acesso" : `${pending} pedidos de acesso`);
      a.hidden = !pending;
    });
  }

  // no máximo 1 consulta a cada 30 s; só admin e só com o Entra ligado
  async function refreshPending(s) {
    if (!s.admin || Date.now() - pendingAt < 30000) return;
    pendingAt = Date.now();
    try {
      if (entraOn === null) entraOn = Boolean((await (await fetch(BASE + "/admin/entra/config", { cache: "no-store" })).json()).habilitado);
      if (!entraOn) return;
      const r = await fetch(BASE + "/admin/entra/pedidos", { headers: { "X-Auth": s.token }, cache: "no-store" });
      if (!r.ok) return;
      pending = (await r.json()).filter((p) => p.status === "pendente").length;
      paintPending();
    } catch (_) { /* sem aviso */ }
  }

  // ---------- dados ----------
  async function loadTeams(s) {
    if (teams && Date.now() - teamsAt < 30000) return teams;
    const map = new Map();
    try {
      const r = await fetch(`${API}/resources/`, { headers: { "X-Auth": s.token } });
      const root = await r.json();
      const dirs = (root.items || []).filter((i) => i.isDir && !/^[_.]/.test(i.name));
      await Promise.all(dirs.map(async (d) => {
        const t = await fetch(`${BASE}/${encodeURIComponent(d.name)}/.time.json`, { cache: "no-cache" });
        if (t.status !== 200) return;
        const cfg = await t.json().catch(() => ({}));
        map.set(d.name, typeof cfg.nome === "string" && cfg.nome ? cfg.nome : d.name);
      }));
    } catch (_) { /* sem coluna de time */ }
    teams = map;
    teamsAt = Date.now();
    return map;
  }

  async function loadAuthors(s, path) {
    const hit = dirCache.get(path);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
    const map = new Map();
    try {
      const base = path ? enc(path) + "/" : "";
      // confere na listagem antes de ler, para não gerar 404 no console
      const dir = await (await fetch(`${API}/resources/${base}`, { headers: { "X-Auth": s.token } })).json();
      const exists = (dir.items || []).some((i) => !i.isDir && i.name === ".autoria");
      const r = exists ? await fetch(`${API}/raw/${base}.autoria`, { headers: { "X-Auth": s.token }, cache: "no-cache" }) : null;
      if (r && r.ok) {
        for (const line of (await r.text()).split("\n")) {
          const [name, user, at, event] = line.split("\t");
          if (!name || !user) continue;
          if (event === "after_delete" || event === "renamed") map.delete(name);
          else map.set(name, { user, at });
        }
      }
    } catch (_) { /* sem autoria */ }
    dirCache.set(path, { at: Date.now(), map });
    return map;
  }

  // ---------- 2. colunas ----------
  function cell(row, cls) {
    const box = row.querySelector(":scope > div:last-child");
    if (!box) return null;
    let p = box.querySelector(`p.${cls}`);
    if (!p) {
      p = document.createElement("p");
      p.className = cls;
      box.append(p);
    }
    return p;
  }

  function header(listing, cls, text) {
    const h = listing.querySelector(".item.header");
    if (!h) return;
    const p = cell(h, cls);
    if (p && !p.textContent) {
      const span = document.createElement("span");
      span.textContent = text;
      p.append(span);
    }
  }

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  };

  let busy = false;
  async function annotate(s) {
    const listing = document.querySelector("#listing.list");
    const path = currentPath();
    if (!listing || path === null || busy || !s.admin) return;
    busy = true;
    try {
      const [authors, teamMap] = await Promise.all([loadAuthors(s, path), loadTeams(s)]);
      listing.classList.add("sp-cols", "sp-cols-team");
      header(listing, "sp-team", "Time");
      header(listing, "sp-who", "Alterado por");

      const top = path.split("/")[0];
      for (const row of listing.querySelectorAll(".item:not(.header)")) {
        const name = row.getAttribute("aria-label") || "";
        const team = teamMap.get(path ? top : name) || "";
        const pt = cell(row, "sp-team");
        if (pt && pt.textContent !== (team || "-")) pt.textContent = team || "-";
        const a = authors.get(name);
        const pw = cell(row, "sp-who");
        if (pw) {
          const text = a ? a.user : "-";
          if (pw.textContent !== text) pw.textContent = text;
          pw.title = a ? `${a.user} · ${fmtDate(a.at)}` : "";
        }
      }
    } finally {
      busy = false;
    }
  }

  // ---------- 3. login Microsoft (só na tela de login) ----------
  function loadEntraLogin() {
    if (window.__spEntraLogin || document.querySelector("script[data-sp-entra]")) return;
    if (!/^\/admin\/login\/?$/.test(location.pathname.slice(BASE.length))) return;
    const s = document.createElement("script");
    s.src = BASE + "/admin/times/entra-login.js";
    s.dataset.spEntra = "";
    document.head.append(s);
  }

  // ---------- 5. tela de login: link para o guia de publicação ----------
  // Idempotente; funciona também com o login Microsoft desligado.
  function decorateLogin() {
    const login = document.querySelector("#login");
    const form = login && login.querySelector("form");
    if (!form || login.dataset.spDeco) return;
    login.dataset.spDeco = "1";
    const foot = document.createElement("p");
    foot.className = "sp-login-foot";
    const guia = document.createElement("a");
    guia.href = BASE + "/_ajuda/";
    guia.target = "_blank";
    guia.rel = "noopener";
    guia.textContent = "Como publicar";
    foot.append(guia);
    form.append(foot);
  }

  // O File Browser reescreve o texto do botão ("Login") quando a tela atualiza: reaplica a cada ciclo.
  function fixLoginTexts() {
    const submit = document.querySelector("#login form input[type=submit]");
    if (submit && submit.value !== "Entrar") submit.value = "Entrar";
  }

  // ---------- 7. "Ajuda" do menu abre o guia de publicação (em português), não a ajuda nativa em inglês ----------
  function fixHelp() {
    const a = document.querySelector("nav p.credits a");
    if (!a || a.dataset.spGuia) return;
    a.dataset.spGuia = "1";
    a.href = BASE + "/_ajuda/";
    a.target = "_blank";
    a.rel = "noopener";
    a.addEventListener("click", (e) => { e.stopImmediatePropagation(); }, true);   // o File Browser abriria o popup dele
  }

  // ---------- 6. tamanhos em português: KB, MB, GB com vírgula (o File Browser mostra KiB, MiB, GiB) ----------
  const UNIT = { B: "B", KiB: "KB", MiB: "MB", GiB: "GB", TiB: "TB" };
  const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(B|KiB|MiB|GiB|TiB)\b/g;
  const ptSize = (txt) => txt.replace(SIZE_RE, (_, n, u) => `${n.replace(".", ",")} ${UNIT[u]}`)
    .replace(/\s+of\s+/, " de ").replace(/\s+used\s*$/, " usados");
  function fixUnits() {
    const targets = [...document.querySelectorAll("#listing .item .size")];
    document.querySelectorAll("nav div.credits").forEach((c) => targets.push(c));
    for (const el of targets) {
      for (const node of el.childNodes) {
        if (node.nodeType !== 3) continue;   // só texto direto (não mexe na barra de progresso)
        const novo = ptSize(node.nodeValue);
        if (novo !== node.nodeValue) node.nodeValue = novo;
      }
    }
  }

  // ---------- 4. título da aba ----------
  // O File Browser põe "<tela> - <nome>" na aba (ex.: "srv - Arquivos - Static Pages").
  // Aqui a aba mostra sempre só o nome do produto (FB_BRANDING_NAME).
  const TITLE = (window.FileBrowser && window.FileBrowser.Name) || "Static Pages";
  function fixTitle() { if (document.title !== TITLE) document.title = TITLE; }
  fixTitle();
  new MutationObserver(fixTitle).observe(document.head, { childList: true, subtree: true, characterData: true });

  // ---------- ciclo ----------
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      loadEntraLogin();
      decorateLogin();
      fixLoginTexts();
      fixUnits();
      fixHelp();
      const s = session();
      if (!s) return;
      addMenuItem(s);
      loadMe(s).then(() => addWhoChip(s));
      refreshPending(s);
      annotate(s);
    }, 120);
  }

  new MutationObserver((records) => {
    // ignora mutações feitas por nós mesmos
    if (records.every((r) => r.target.closest && r.target.closest(".sp-team, .sp-who"))) return;
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  document.addEventListener("DOMContentLoaded", schedule);
})();
