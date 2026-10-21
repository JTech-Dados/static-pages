// ============================================================
// Abas "Lixeira" e "Atividade" da tela de Times.
// Carregado depois do script principal de times.html e reutiliza
// os helpers dele (api, el, enc, toast, state, token).
//
// Lixeira  : /srv/_lixeira/.registro (hook sp-lixeira)
//            restaurar = mover de volta; apagar = definitivo
// Atividade: /admin/_auditoria (auditoria.log do hook sp-autoria),
//            liberado pelo NGINX só para admins (auth_request)
// ============================================================
(function () {
  "use strict";

  const TRASH = "/_lixeira";
  const MAX_ROWS = 300;
  const views = ["times", "lixeira", "atividade"];
  const loaded = new Set();

  const fmtWhen = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  };
  const teamOf = (path) => {
    const top = String(path || "").replace(/^\/srv/, "").split("/").filter(Boolean)[0] || "";
    const t = state.teams.find((x) => x.slug === top);
    return t ? t.nome : top ? `/${top}/` : "/";
  };

  // ---------- abas ----------
  function show(view) {
    if (!views.includes(view)) view = "times";
    document.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== view));
    document.querySelectorAll("[data-view-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.viewTab === view)));
    const btn = document.querySelector("#btn-new");
    if (btn && requireAdmin() === "ok") btn.hidden = view !== "times";
    if (view === "lixeira") loadTrash();
    if (view === "atividade" && !loaded.has("atividade")) loadActivity();
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));

  // ---------- lixeira ----------
  // O .registro é a fonte da verdade: restaurar/apagar remove a linha
  // (e a limpeza diária do entrypoint poda o que expirou).
  let trashLines = [];

  async function readRegistry() {
    let text = "";
    // no-store: o registro muda a cada restauração; o cache HTTP devolveria a versão antiga
    try { text = String(await api(`/raw${TRASH}/.registro`, { cache: "no-store" })); } catch { text = ""; }
    trashLines = text.split("\n").filter(Boolean);
    return trashLines.map((line) => {
      const [when, who, original, inTrash] = line.split("\t");
      return { line, when, who, original, inTrash };
    }).filter((e) => e.inTrash);
  }

  async function dropFromRegistry(entry) {
    const rest = trashLines.filter((l) => l !== entry.line);
    await api(`/resources${TRASH}/.registro?override=true`, { method: "POST", body: rest.length ? rest.join("\n") + "\n" : "" });
    // apaga o lote vazio (/_lixeira/<dia>/<lote>/) para não acumular pastas
    const lote = entry.inTrash.split("/").slice(0, 4).join("/");
    try {
      const info = await api(`/resources${enc(lote)}/`);
      if (!(info.items || []).length) await api(`/resources${enc(lote)}/`, { method: "DELETE" });
    } catch { /* já não existe */ }
  }

  async function loadTrash() {
    const box = document.querySelector("#trash");
    box.replaceChildren(el("div", "skeleton"));
    const alive = (await readRegistry()).reverse().slice(0, MAX_ROWS);
    document.querySelector("#trash-note").textContent = `${alive.length} ${alive.length === 1 ? "item" : "itens"} · apagados somem após 30 dias`;

    box.replaceChildren();
    if (!alive.length) {
      box.append(el("div", "empty", "A lixeira está vazia. Tudo que for apagado no painel aparece aqui para ser restaurado."));
      return;
    }
    const wrap = el("div", "table-wrap");
    const table = el("table", "table");
    const head = el("tr");
    for (const h of ["Arquivo", "Time", "Apagado por", "Quando", ""]) head.append(el("th", null, h));
    table.append(head);
    for (const e of alive) {
      const tr = el("tr");
      tr.append(el("td", "path", e.original), el("td", null, teamOf(e.original)), el("td", null, e.who), el("td", "when", fmtWhen(e.when)));
      const acts = el("td", "acts");
      const restore = el("button", "btn secondary sm", "Restaurar");
      restore.type = "button";
      restore.onclick = () => restoreItem(e, restore);
      const purge = el("button", "btn danger sm", "Apagar de vez");
      purge.type = "button";
      purge.onclick = () => purgeItem(e);
      acts.append(restore, purge);
      tr.append(acts);
      table.append(tr);
    }
    wrap.append(table);
    box.append(wrap);
  }

  async function restoreItem(e, button) {
    button.disabled = true;
    try {
      // recria a pasta de destino, se ela também foi apagada
      const parent = e.original.replace(/\/[^/]+\/?$/, "");
      if (parent) await api(`/resources${enc(parent)}/`, { method: "POST" }).catch(() => {});
      // rename=true: se já existir algo com o mesmo nome, o File Browser cria "nome(1)"
      const q = new URLSearchParams({ action: "rename", destination: e.original, override: "false", rename: "true" });
      await api(`/resources${enc(e.inTrash)}?${q}`, { method: "PATCH" });
      await dropFromRegistry(e);
      toast(`${e.original} restaurado.`);
      loadTrash();
      loaded.delete("atividade");
      if (typeof load === "function") load().catch(() => {});
    } catch (err) {
      button.disabled = false;
      toast(err.message, true);
    }
  }

  async function purgeItem(e) {
    if (!confirm(`Apagar definitivamente ${e.original}? Isso não pode ser desfeito.`)) return;
    try {
      await api(`/resources${enc(e.inTrash)}`, { method: "DELETE" }).catch(() => {});
      await dropFromRegistry(e);
      toast("Apagado definitivamente.");
      loadTrash();
    } catch (err) { toast(err.message, true); }
  }

  // ---------- atividade ----------
  const EVENTS = {
    after_upload: ["enviou", "new"], after_save: ["editou", ""], after_rename: ["renomeou/moveu", ""],
    after_copy: ["copiou", ""], after_delete: ["apagou", "del"],
  };
  let activity = [];

  async function loadActivity() {
    const box = document.querySelector("#activity");
    box.replaceChildren(el("div", "skeleton"));
    try {
      const r = await fetch("/admin/_auditoria", { headers: { "X-Auth": token }, cache: "no-cache" });
      if (r.status === 404) { activity = []; }
      else if (!r.ok) throw new Error(`Erro ${r.status} ao ler a atividade`);
      else {
        activity = (await r.text()).split("\n").filter(Boolean).map((l) => {
          const [when, who, event, file, dest] = l.split("\t");
          const path = (dest || file || "").replace(/^\/srv/, "") || "/";
          return { when, who, event, path, from: dest ? (file || "").replace(/^\/srv/, "") : "", team: teamOf(path) };
        }).reverse();
      }
      loaded.add("atividade");
      fillFilters();
      renderActivity();
    } catch (err) {
      box.replaceChildren(el("div", "empty", err.message));
    }
  }

  function fillFilters() {
    const teamSel = document.querySelector("#act-team"), userSel = document.querySelector("#act-user");
    const uniq = (xs) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, "pt-BR"));
    teamSel.length = 1; userSel.length = 1;
    for (const t of uniq(activity.map((a) => a.team))) teamSel.append(new Option(t, t));
    for (const u of uniq(activity.map((a) => a.who))) userSel.append(new Option(u, u));
  }

  function renderActivity() {
    const team = document.querySelector("#act-team").value;
    const user = document.querySelector("#act-user").value;
    const q = document.querySelector("#act-q").value.trim().toLowerCase();
    const rows = activity.filter((a) => (!team || a.team === team) && (!user || a.who === user) && (!q || a.path.toLowerCase().includes(q)));

    const box = document.querySelector("#activity");
    box.replaceChildren();
    if (!rows.length) {
      box.append(el("div", "empty", activity.length ? "Nada encontrado para esses filtros." : "Nenhuma atividade registrada ainda."));
      return;
    }
    const wrap = el("div", "table-wrap");
    const table = el("table", "table");
    const head = el("tr");
    for (const h of ["Quando", "Pessoa", "Ação", "Arquivo", "Time"]) head.append(el("th", null, h));
    table.append(head);
    for (const a of rows.slice(0, MAX_ROWS)) {
      const [label, cls] = EVENTS[a.event] || [a.event, ""];
      const tr = el("tr");
      const ev = el("td");
      const restored = a.event === "after_rename" && a.from.startsWith(TRASH + "/");
      ev.append(el("span", "ev " + (restored ? "new" : cls), restored ? "restaurou" : label));
      const file = el("td", "path", a.path);
      if (a.from) file.title = `de ${a.from}`;
      tr.append(el("td", "when", fmtWhen(a.when)), el("td", null, a.who), ev, file, el("td", null, a.team));
      table.append(tr);
    }
    wrap.append(table);
    box.append(wrap);
    if (rows.length > MAX_ROWS) box.append(el("div", "more", `Mostrando as ${MAX_ROWS} mais recentes de ${rows.length}. Use os filtros para refinar.`));
  }

  ["#act-team", "#act-user", "#act-q"].forEach((s) => document.querySelector(s).addEventListener("input", renderActivity));

  if (requireAdmin() === "ok") show(location.hash.slice(1));
})();
