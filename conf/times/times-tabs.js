// ============================================================
// Abas "Lixeira" e "Atividade" da tela de Times.
// Carregado depois do script principal de times.html e reutiliza
// os helpers dele (api, el, enc, toast, state, token).
//
// Lixeira  : /srv/_lixeira/.registro (hook sp-lixeira)
//            restaurar = mover de volta; apagar = definitivo
// Atividade: <prefixo>/admin/_auditoria (auditoria.log do hook sp-autoria),
//            liberado pelo NGINX só para admins (auth_request)
// Acessos  : pedidos de acesso do login Microsoft (sp-auth, entra/pedidos);
//            só aparece quando o Entra ID está configurado
// ============================================================
(function () {
  "use strict";

  const TRASH = "/_lixeira";
  const MAX_ROWS = 300;
  const views = ["times", "lixeira", "atividade", "usuarios", "acessos"];
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
    if (view === "acessos") loadAccess();
    if (view === "usuarios") loadUsers();
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));

  // ---------- usuários: papel (Admin, Editor, Leitor) e time de cada pessoa ----------
  const READER_PERM = { admin: false, execute: false, create: false, rename: false, modify: false, delete: false, share: false, download: true };
  const ADMIN_PERM = { admin: true, execute: true, create: true, rename: true, modify: true, delete: true, share: true, download: true };
  const ROLE_PERMS = { admin: ADMIN_PERM, editor: MEMBER_PERM, leitor: READER_PERM };
  const ROLE_NAMES = { admin: "Admin", editor: "Editor", leitor: "Leitor" };
  const roleOf = (u) => (u.perm.admin ? "admin" : u.perm.create || u.perm.modify ? "editor" : "leitor");
  const myId = () => { try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).user.id; } catch { return null; } };

  // Admin enxerga tudo (escopo "/", dotfiles visíveis); editor e leitor ficam presos à pasta do time
  async function applyRole(u, role, slug) {
    const base = role === "admin" ? { scope: "/", hideDotfiles: false } : { scope: "/" + slug, hideDotfiles: true };
    await api(`/users/${u.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: userBody({ id: u.id, perm: ROLE_PERMS[role], ...base }, ["perm", "scope", "hideDotfiles"]) });
  }

  function askTeam(u, role) {
    return new Promise((resolve) => {
      const dlg = document.querySelector("#dlg-role"), f = document.querySelector("#form-role");
      document.querySelector("#role-title").textContent = `Tornar ${nomeDe(u)} ${ROLE_NAMES[role]}`;
      document.querySelector("#role-hint").textContent = "Quem não é admin só enxerga a pasta de um time. Escolha qual.";
      f.team.replaceChildren(new Option("Escolha o time…", ""));
      for (const t of state.teams) f.team.append(new Option(t.nome, t.slug));
      dlg.onclose = () => resolve(dlg.returnValue === "ok" ? f.team.value : null);
      dlg.returnValue = "";
      dlg.showModal();
    });
  }

  async function changeRole(u, role) {
    try {
      if (role === "admin") {
        if (!confirm(`Tornar ${nomeDe(u)} administrador? A pessoa passa a ver todos os times e a gerenciar acessos.`)) return;
        await applyRole(u, "admin");
      } else if (u.perm.admin) {
        const slug = await askTeam(u, role);
        if (!slug) return;
        await applyRole(u, role, slug);
      } else {
        await api(`/users/${u.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: userBody({ id: u.id, perm: ROLE_PERMS[role] }, ["perm"]) });
      }
      toast(`${nomeDe(u)} agora é ${ROLE_NAMES[role]}.`);
      logEvento("acesso_papel", `${u.username} agora é ${ROLE_NAMES[role]}`);
    } catch (e) { toast(e.message, true); }
    await load();
    loadUsers();
  }

  async function loadUsers() {
    const box = document.querySelector("#users");
    await window.spLoading;
    const me = myId();
    const list = state.users.filter((u) => u.username !== "sp-svc")   // conta técnica do login Microsoft
      .sort((a, b) => Number(b.perm.admin) - Number(a.perm.admin) || nomeDe(a).localeCompare(nomeDe(b), "pt-BR"));
    document.querySelector("#users-count").textContent = String(list.length);
    if (!list.length) { box.replaceChildren(el("div", "empty", "Nenhum usuário ainda.")); return; }

    const table = el("table", "table");
    const thead = el("thead"), head = el("tr");
    for (const h of ["Pessoa", "Papel", "Time", ""]) head.append(el("th", null, h));
    thead.append(head);
    table.append(thead);
    const body = el("tbody");
    for (const u of list) {
      const self = u.id === me;
      const tr = el("tr");
      const who = el("td");
      who.append(el("b", null, nomeDe(u)));
      if (nomeDe(u) !== u.username) who.append(el("br"), el("span", "mono", u.username));
      if (self) who.append(" ", el("span", "ev", "você"));

      const roleCell = el("td");
      const role = el("select");
      role.setAttribute("aria-label", `Papel de ${nomeDe(u)}`);
      for (const [v, label] of Object.entries(ROLE_NAMES)) role.append(new Option(label, v));
      role.value = roleOf(u);
      role.disabled = self;   // ninguém muda o próprio papel (evita se trancar para fora)
      role.onchange = () => { const novo = role.value; role.value = roleOf(u); changeRole(u, novo); };
      roleCell.append(role);

      const teamCell = el("td");
      if (u.perm.admin) {
        teamCell.append(el("span", "faint", "Todos os times"));
      } else {
        const cur = state.teams.find((t) => normScope(u.scope) === "/" + t.slug || normScope(u.scope).startsWith("/" + t.slug + "/"));
        const sel = el("select");
        sel.setAttribute("aria-label", `Time de ${nomeDe(u)}`);
        sel.append(new Option(cur ? cur.nome : "Sem time", cur ? "/" + cur.slug : NO_TEAM_SCOPE));
        for (const t of state.teams) if (!cur || t.slug !== cur.slug) sel.append(new Option(t.nome, "/" + t.slug));
        if (cur) sel.append(new Option("Sem time", NO_TEAM_SCOPE));
        sel.onchange = async () => { await moveUser(u, sel.value, sel.selectedOptions[0].text); loadUsers(); };
        teamCell.append(sel);
      }

      const acts = el("td", "acts");
      const del = el("button", "btn danger sm", "Remover");
      del.type = "button";
      del.disabled = self;
      del.onclick = async () => { await deleteUser(u); loadUsers(); };
      acts.append(del);

      tr.append(who, roleCell, teamCell, acts);
      body.append(tr);
    }
    table.append(body);
    const wrap = el("div", "table-wrap");
    wrap.append(table);
    box.replaceChildren(wrap);
  }

  // ---------- acessos (login Microsoft) ----------
  const ENTRA = window.SP_BASE + "/admin/entra";
  const entraApi = async (path, opts = {}) => {
    const r = await fetch(ENTRA + path, { ...opts, headers: { "X-Auth": token, "Content-Type": "application/json", ...(opts.headers || {}) }, cache: "no-store" });
    if (!r.ok) throw new Error(`Erro ${r.status} em ${path}`);
    return r.json();
  };

  async function refreshBadge() {
    try {
      const n = (await entraApi("/pedidos")).filter((p) => p.status === "pendente").length;
      const badge = document.querySelector("#acc-badge");
      if (badge) badge.textContent = n ? `(${n})` : "";
    } catch { /* sem contador */ }
  }

  async function loadAccess() {
    const box = document.querySelector("#access");
    box.replaceChildren(el("div", "skeleton"));
    await window.spLoading;   // state.teams precisa estar carregado para o seletor de time
    let list;
    try { list = await entraApi("/pedidos"); } catch (e) { box.replaceChildren(el("div", "notice", e.message)); return; }
    document.querySelector("#acc-badge").textContent = list.filter((p) => p.status === "pendente").length ? `(${list.filter((p) => p.status === "pendente").length})` : "";
    if (!list.length) { box.replaceChildren(el("div", "empty", "Nenhum pedido de acesso no momento.")); return; }

    const table = el("table", "table");
    const head = el("tr");
    for (const h of ["Pessoa", "Pedido em", "Time", ""]) head.append(el("th", null, h));
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const body = el("tbody");
    for (const p of list) {
      const tr = el("tr");
      const who = el("td");
      who.append(p.curto || p.nome || p.email);
      if (p.nome || p.curto) { who.append(el("br"), el("span", "mono", p.email)); }
      const when = el("td", "when", fmtWhen(p.em));
      const teamCell = el("td");
      const sel = el("select", "full");
      sel.setAttribute("aria-label", `Time para ${p.email}`);
      sel.append(new Option(state.teams.length ? "Escolha o time…" : "Crie um time antes", ""));
      for (const t of state.teams) sel.append(new Option(t.nome, t.slug));
      if (p.status === "pendente") teamCell.append(sel); else teamCell.append(el("span", "ev del", "recusado"));
      const acts = el("td", "acts");
      if (p.status === "pendente") {
        const ok = el("button", "btn sm", "Aprovar"); ok.type = "button";
        ok.onclick = async () => {
          const t = state.teams.find((x) => x.slug === sel.value);
          if (!t) { toast("Escolha o time da pessoa.", true); return; }
          ok.disabled = true;
          try {
            await addMicrosoftMember(p.email, t, true);
            logEvento("acesso_aprovado", `${p.email} aprovado no time ${t.nome}`);
            await entraApi("/pedidos/remover", { method: "POST", body: JSON.stringify({ email: p.email }) });
            await loadAccess();
          } catch (e) { ok.disabled = false; toast(e.message, true); }
        };
        const no = el("button", "btn danger sm", "Recusar"); no.type = "button";
        no.onclick = async () => {
          try { await entraApi("/pedidos/recusar", { method: "POST", body: JSON.stringify({ email: p.email }) }); await loadAccess(); } catch (e) { toast(e.message, true); }
        };
        acts.append(ok, no);
      } else {
        const rm = el("button", "btn secondary sm", "Remover da lista"); rm.type = "button";
        rm.onclick = async () => {
          try { await entraApi("/pedidos/remover", { method: "POST", body: JSON.stringify({ email: p.email }) }); await loadAccess(); } catch (e) { toast(e.message, true); }
        };
        acts.append(rm);
      }
      tr.append(who, when, teamCell, acts);
      body.append(tr);
    }
    table.append(body);
    const wrap = el("div", "table-wrap");
    wrap.append(table);
    box.replaceChildren(wrap);
  }

  // O Entra ID é opcional: sem ENTRA_TENANT_ID/ENTRA_CLIENT_ID, a aba Pedidos e a opção Conta Microsoft ficam escondidas
  (async function initEntra() {
    try {
      const cfg = await (await fetch(ENTRA + "/config", { cache: "no-store" })).json();
      if (!cfg.habilitado) return;
      document.querySelectorAll("[data-entra]").forEach((n) => (n.hidden = false));
      if (requireAdmin() === "ok") refreshBadge();
    } catch { /* continua sem Entra */ }
  })();

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
    // gestão de acessos (sp-auth e tela Acessos): o 4º campo do log é um texto, não um caminho
    acesso_login: ["entrou (Microsoft)", "new"], acesso_pedido: ["pediu acesso", ""], acesso_aprovado: ["aprovou acesso", "new"],
    acesso_recusado: ["recusou acesso", "del"], acesso_criado: ["adicionou pessoa", "new"], acesso_papel: ["mudou o papel", ""],
    acesso_time: ["moveu de time", ""], acesso_removido: ["removeu pessoa", "del"], acesso_cota: ["envio recusado (cota)", "del"],
  };
  let activity = [];

  async function loadActivity() {
    const box = document.querySelector("#activity");
    box.replaceChildren(el("div", "skeleton"));
    try {
      const r = await fetch(window.SP_BASE + "/admin/_auditoria", { headers: { "X-Auth": token }, cache: "no-cache" });
      if (r.status === 404) { activity = []; }
      else if (!r.ok) throw new Error(`Erro ${r.status} ao ler a atividade`);
      else {
        activity = (await r.text()).split("\n").filter(Boolean).map((l) => {
          const [when, who, event, file, dest] = l.split("\t");
          if ((event || "").startsWith("acesso_")) return { when, who, event, path: file || "", from: "", team: "-" };
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
