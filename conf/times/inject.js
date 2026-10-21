// ============================================================
// Extensões do painel do File Browser, injetadas pelo NGINX
// (sub_filter) no HTML do /admin:
//
//   1. Item "Times" no menu lateral (só admins)
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

  const API = "/admin/api";
  const CACHE_MS = 3000;
  const dirCache = new Map();   // caminho -> { at, map }
  let teams = null;             // nome da pasta de 1º nível -> nome do time
  let teamsAt = 0;

  // ---------- sessão ----------
  function session() {
    try {
      const token = localStorage.getItem("jwt");
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return { token, admin: Boolean(payload.user && payload.user.perm && payload.user.perm.admin) };
    } catch (_) {
      return null;
    }
  }

  const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

  // caminho atual da listagem, relativo à raiz do usuário: "" ou "a/b"
  function currentPath() {
    const m = decodeURIComponent(location.pathname).match(/^\/admin\/files\/?(.*?)\/?$/);
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
    link.href = "/admin/times";
    link.dataset.spTimes = "";
    link.title = "Times";
    link.setAttribute("aria-label", "Times");
    const icon = document.createElement("i");
    icon.className = "material-icons";
    icon.textContent = "groups";
    const label = document.createElement("span");
    label.textContent = "Times";
    link.append(icon, label);
    settings.parentNode.insertBefore(link, settings);
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
        const t = await fetch(`/${encodeURIComponent(d.name)}/.time.json`, { cache: "no-cache" });
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
        if (pt && pt.textContent !== (team || "—")) pt.textContent = team || "—";
        const a = authors.get(name);
        const pw = cell(row, "sp-who");
        if (pw) {
          const text = a ? a.user : "—";
          if (pw.textContent !== text) pw.textContent = text;
          pw.title = a ? `${a.user} · ${fmtDate(a.at)}` : "";
        }
      }
    } finally {
      busy = false;
    }
  }

  // ---------- ciclo ----------
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = session();
      if (!s) return;
      addMenuItem(s);
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
