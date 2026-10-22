#!/usr/bin/env node
// ============================================================
// sp-auth — ponte entre o login Microsoft (Entra ID) e o File Browser.
//
// Roda dentro do container, só em 127.0.0.1:8090; o NGINX expõe em
// <prefixo>/admin/entra/. Sem dependências (só Node).
//
// Fluxo:
//   1. A tela de login do painel (entra-login.js) faz o login Microsoft
//      no navegador (MSAL em popup; Redirect URI = ENTRA_REDIRECT_URI ou <prefixo>/admin/entra/retorno) e
//      manda o ID token para POST /admin/entra/login.
//   2. Aqui o token é VALIDADO (assinatura RS256 pelas chaves do Entra,
//      emissor, audiência, tenant, validade e uso único).
//   3. O e-mail precisa ser um usuário do File Browser (nome de usuário
//      com "@", não admin) — cadastrado na tela de Times ou aprovado a
//      partir de um pedido de acesso. Se for, a senha dele é trocada por
//      uma aleatória e devolvida UMA vez; a tela de login a usa no login
//      nativo do File Browser (token, cookies e permissões normais).
//   4. Se não for, o login é recusado e a pessoa pode pedir acesso: o
//      pedido fica em /database/entra-pedidos.json até um admin aprovar
//      (cria o usuário) ou recusar, na tela de Times.
//
// Contas de e-mail entram pela Microsoft, inclusive admin (quem promove alguém não pode trancá-lo
// para fora). O "admin" local (sem @) continua só com usuário e senha, como contingência. A conta técnica "sp-svc" (admin do File Browser, senha
// aleatória a cada boot em /run/sp-auth/svc) só existe para listar
// usuários e trocar senhas.
// ============================================================
"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const pathLib = require("node:path");

const MAX_BODY = 16 * 1024;
const MAX_TOKEN = 8 * 1024;
const MAX_PEDIDOS = 500;
const TOKEN_MAX_AGE_S = 600;       // ID token precisa ter sido emitido há no máximo 10 min
const SKEW_S = 60;
const RECUSADO_DIAS = 90;

const b64u = (s) => Buffer.from(s, "base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Maria Souza de Oliveira Santos" -> "Maria Santos"; sem nome, deduz do e-mail (maria.santos@x -> Maria Santos)
function nomeCurto(nome, fallback) {
  let partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length && String(fallback || "").includes("@")) {
    partes = String(fallback).split("@")[0].split(/[._-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  }
  if (!partes.length) return String(fallback || "");
  return partes.length === 1 ? partes[0] : `${partes[0]} ${partes[partes.length - 1]}`;
}

// Tamanho de uma pasta (bytes). Limite de entradas para não travar; cache curto.
function dirBytes(dir, maxEntries = 50000) {
  let total = 0, seen = 0;
  const pilha = [dir];
  while (pilha.length) {
    const atual = pilha.pop();
    let itens;
    try { itens = fs.readdirSync(atual, { withFileTypes: true }); } catch { continue; }
    for (const it of itens) {
      if (++seen > maxEntries) return total;
      const p = pathLib.join(atual, it.name);
      if (it.isDirectory()) pilha.push(p);
      else if (it.isFile()) { try { total += fs.statSync(p).size; } catch { /* sumiu */ } }
    }
  }
  return total;
}

class HttpError extends Error {
  constructor(status, body) { super(body.erro || String(status)); this.status = status; this.body = body; }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(new Error("resposta grande demais")); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// ---------- validação do ID token ----------
function createVerifier(o) {
  let jwks = null, jwksAt = 0, lastRefetch = 0;
  const used = new Map();   // sha256(token) -> exp (s): bloqueia reuso do mesmo token

  async function loadJwks(force) {
    const now = Date.now();
    if (jwks && !force && now - jwksAt < 3600e3) return jwks;
    if (force && now - lastRefetch < (o.refetchCooldownMs ?? 300e3)) return jwks;   // no máx. 1 releitura forçada a cada 5 min (kid desconhecido)
    lastRefetch = now;
    jwks = await o.jwksLoader();
    jwksAt = now;
    return jwks;
  }

  return async function verify(token) {
    const fail = () => new HttpError(401, { erro: "token_invalido" });
    if (typeof token !== "string" || token.length > MAX_TOKEN) throw fail();
    const parts = token.split(".");
    if (parts.length !== 3) throw fail();
    let header, payload;
    try {
      header = JSON.parse(b64u(parts[0]).toString());
      payload = JSON.parse(b64u(parts[1]).toString());
    } catch { throw fail(); }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw fail();

    let set = await loadJwks(false);
    let jwk = ((set && set.keys) || []).find((k) => k.kid === header.kid);
    if (!jwk) {
      set = await loadJwks(true);
      jwk = ((set && set.keys) || []).find((k) => k.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA") throw fail();

    let ok = false;
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, b64u(parts[2]));
    } catch { ok = false; }
    if (!ok) throw fail();

    const now = Math.floor(o.now() / 1000);
    if (payload.iss !== `https://login.microsoftonline.com/${o.tenant}/v2.0`) throw fail();
    if (payload.tid !== o.tenant) throw fail();
    if (payload.aud !== o.clientId) throw fail();
    if (!Number.isFinite(payload.exp) || payload.exp < now - SKEW_S) throw fail();
    if (Number.isFinite(payload.nbf) && payload.nbf > now + SKEW_S) throw fail();
    if (!Number.isFinite(payload.iat) || payload.iat < now - TOKEN_MAX_AGE_S) throw fail();

    const email = String(payload.preferred_username || payload.email || payload.upn || "").trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)) throw fail();

    // Uso único só para quem ganha credenciais: consume() recusa um token que já liberou um login.
    // "Sem acesso" e "solicitar" reaproveitam o mesmo token (a tela chama os dois em sequência)
    // e não geram credencial, então não consomem.
    const h = crypto.createHash("sha256").update(token).digest("hex");
    const consume = () => {
      for (const [k, exp] of used) if (exp < now - SKEW_S) used.delete(k);
      if (used.has(h)) throw fail();
      used.set(h, payload.exp);
    };

    return { email, nome: String(payload.name || "").slice(0, 120), consume };
  };
}

// ---------- File Browser (API local, como conta técnica) ----------
function createFb(o) {
  let svcToken = null, svcAt = 0;

  async function raw(method, path, { token, body } = {}) {
    const r = await fetch(o.fbBase + "/api" + path, {
      method,
      headers: { ...(token ? { "X-Auth": token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    return r;
  }

  async function login() {
    const { user, pass } = o.svc();
    const r = await raw("POST", "/login", { body: { username: user, password: pass, recaptcha: "" } });
    if (!r.ok) throw new Error(`login técnico recusado (${r.status})`);
    svcToken = (await r.text()).trim();
    svcAt = Date.now();
  }

  async function svc(method, path, body) {
    if (!svcToken || Date.now() - svcAt > 30 * 60e3) await login();
    let r = await raw(method, path, { token: svcToken, body });
    if (r.status === 401) { await login(); r = await raw(method, path, { token: svcToken, body }); }
    return r;
  }

  return {
    async users() {
      const r = await svc("GET", "/users");
      if (!r.ok) throw new Error(`users ${r.status}`);
      return r.json();
    },
    async setPassword(id, password) {
      const r = await svc("PUT", `/users/${id}`, { what: "user", which: ["password"], data: { id, password } });
      if (!r.ok) throw new Error(`troca de senha ${r.status}`);
    },
    asUserGet: (token, path) => raw("GET", path, { token }),
    // Confere o token do próprio chamador: /users/<id> responde 200 para o dono do token (e para admin)
    async ownUserOk(token, id) {
      if (typeof token !== "string" || !token || !Number.isInteger(id)) return false;
      try { return (await raw("GET", `/users/${id}`, { token })).status === 200; } catch { return false; }
    },
    // O token do chamador só é válido se for de um admin: /api/users responde 200 só para admin.
    async isAdminToken(token) {
      if (typeof token !== "string" || !token) return false;
      try { return (await raw("GET", "/users", { token })).status === 200; } catch { return false; }
    },
  };
}

// ---------- pedidos de acesso ----------
function createPedidos(file, now) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};

  const cutoff = now() - RECUSADO_DIAS * 864e5;
  for (const [email, p] of Object.entries(data)) {
    if (p && p.status === "recusado" && Date.parse(p.em) < cutoff) delete data[email];
  }

  function save() {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o640 });
    fs.renameSync(tmp, file);
  }

  return {
    get: (email) => data[email] || null,
    count: () => Object.keys(data).length,
    list: () => Object.entries(data).map(([email, p]) => ({ email, ...p })).sort((a, b) => a.em.localeCompare(b.em)),
    add(email, nome) {
      data[email] = { nome, status: "pendente", em: new Date(now()).toISOString() };
      save();
    },
    refuse(email) { if (data[email]) { data[email].status = "recusado"; save(); return true; } return false; },
    remove(email) { if (data[email]) { delete data[email]; save(); return true; } return false; },
  };
}

// ---------- histórico de acessos (mesmo auditoria.log da aba Atividade) ----------
// Formato do hook sp-autoria: quando, quem, evento, arquivo, destino (separados por TAB).
// Eventos de acesso começam com "acesso_" e o 4º campo é um texto livre, não um caminho.
function createAudit(file, now) {
  const limpa = (s) => String(s || "").replace(/[\t\r\n]+/g, " ").slice(0, 200);
  return (quem, evento, detalhe) => {
    const linha = [new Date(now()).toISOString().replace(/\.\d+Z$/, "Z"), limpa(quem), limpa(evento), limpa(detalhe), ""].join("\t") + "\n";
    try { fs.appendFileSync(file, linha); } catch { /* sem histórico: não derruba o login */ }
  };
}
const EVENTOS_CLIENTE = new Set(["acesso_criado", "acesso_papel", "acesso_time", "acesso_removido", "acesso_aprovado"]);

// ---------- nomes (e-mail -> nome completo, vindo do token da Microsoft) ----------
function createNomes(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  return {
    all: () => data,
    set(email, nome) {
      const n = String(nome || "").trim().slice(0, 120);
      if (!n || data[email] === n) return;
      data[email] = n;
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o640 });
      fs.renameSync(tmp, file);
    },
  };
}

// ---------- servidor ----------
function createApp(o) {
  const verify = createVerifier(o);
  const fb = createFb(o);
  const pedidos = createPedidos(o.pedidosFile, o.now);
  const nomes = createNomes(o.nomesFile);
  const audit = createAudit(o.auditFile || "/database/auditoria.log", o.now);
  const cotaPadraoMb = Number(o.cotaPadraoMb) > 0 ? Number(o.cotaPadraoMb) : 200;
  const sizeCache = new Map();   // slug -> { at, bytes }
  const slugOk = (s) => /^[A-Za-z0-9._-]+$/.test(s) && !/^[_.]/.test(s);

  // Espaço do time de um usuário: pasta (bytes) x cota. fresh = ignora o cache de tamanho (checagem de upload).
  function quotaInfo(u, fresh) {
    const slug = String(u.scope || "").replace(/^\.?\/+/, "").split("/")[0];
    let used = 0, cota = cotaPadraoMb;
    if (slugOk(slug)) {
      const dir = pathLib.join(o.srvDir, slug);
      try {
        const cfg = JSON.parse(fs.readFileSync(pathLib.join(dir, ".time.json"), "utf8"));
        if (Number(cfg.cota_mb) > 0) cota = Number(cfg.cota_mb);
      } catch { /* cota padrão */ }
      const hit = sizeCache.get(slug);
      if (hit && !fresh && o.now() - hit.at < 30000) used = hit.bytes;
      else { used = dirBytes(dir); sizeCache.set(slug, { at: o.now(), bytes: used }); }
    }
    return { slug: slugOk(slug) ? slug : "", used, total: cota * 1048576 };
  }

  // Quem é o dono do token (id do JWT conferido na API do File Browser), ou 401
  async function userFromToken(req) {
    const token = req.headers["x-auth"];
    let id;
    try { id = JSON.parse(b64u(String(token).split(".")[1]).toString()).user.id; } catch { throw new HttpError(401, { erro: "sessao_invalida" }); }
    if (!(await fb.ownUserOk(token, id))) throw new HttpError(401, { erro: "sessao_invalida" });
    const u = (await fb.users()).find((x) => x.id === id);
    if (!u) throw new HttpError(401, { erro: "sessao_invalida" });
    return u;
  }
  const enabled = Boolean(o.tenant && o.clientId);

  // Conta de e-mail (nome de usuário = e-mail da Microsoft): entra pela Microsoft, inclusive se for admin.
  // O "admin" local (sem @) e a conta técnica sp-svc só entram por senha.
  const isMember = (u, email) => u.username.toLowerCase() === email && u.username.includes("@");
  const findUser = async (email) => (await fb.users()).find((u) => u.username.toLowerCase() === email) || null;

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, { erro: "corpo_grande" });
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw new HttpError(400, { erro: "json_invalido" }); }
  }

  async function requireAdmin(req) {
    if (!(await fb.isAdminToken(req.headers["x-auth"]))) throw new HttpError(403, { erro: "so_admin" });
  }

  const routes = {
    "GET /config": async () => ({
      habilitado: enabled,
      clientId: o.clientId || "",
      authority: enabled ? `https://login.microsoftonline.com/${o.tenant}` : "",
      redirectUri: o.redirectUri,
      cotaPadraoMb,
    }),

    "POST /login": async (req) => {
      const { email, nome, consume } = await verify((await readBody(req)).idToken);
      const u = await findUser(email);
      if (u && isMember(u, email)) {
        consume();   // o mesmo token não libera dois logins
        nomes.set(email, nome);
        // senha nova e aleatória a cada login: nada fica guardado e a antiga morre
        const senha = crypto.randomBytes(24).toString("base64url");
        await fb.setPassword(u.id, senha);
        log(`login ${email}`);
        audit(email, "acesso_login", "entrou com a conta Microsoft");
        return { usuario: u.username, senha };
      }
      if (u) throw new HttpError(403, { erro: "so_senha" });   // admin (ou conta que não é de e-mail)
      const p = pedidos.get(email);
      throw new HttpError(403, { erro: "sem_acesso", pedido: p ? p.status : null });
    },

    "POST /solicitar": async (req) => {
      const { email, nome } = await verify((await readBody(req)).idToken);
      if (await findUser(email)) throw new HttpError(409, { erro: "ja_tem_acesso" });
      nomes.set(email, nome);   // o admin vê o nome da pessoa, não só o e-mail
      const p = pedidos.get(email);
      if (p) return { pedido: p.status };
      if (pedidos.count() >= MAX_PEDIDOS) throw new HttpError(429, { erro: "fila_cheia" });
      pedidos.add(email, nome);
      log(`pedido de acesso ${email}`);
      audit(email, "acesso_pedido", "pediu acesso ao Pages");
      return { pedido: "pendente" };
    },

    // Quem está logado (barra superior do painel): nome, papel e time. O File Browser esconde o
    // escopo de quem consulta a si mesmo, então o sp-auth responde, depois de conferir o token.
    "GET /me": async (req) => {
      const token = req.headers["x-auth"];
      let id;
      try { id = JSON.parse(b64u(String(token).split(".")[1]).toString()).user.id; } catch { throw new HttpError(401, { erro: "sessao_invalida" }); }
      if (!(await fb.ownUserOk(token, id))) throw new HttpError(401, { erro: "sessao_invalida" });
      const u = (await fb.users()).find((x) => x.id === id);
      if (!u) throw new HttpError(401, { erro: "sessao_invalida" });
      const admin = Boolean(u.perm && u.perm.admin);
      const slug = admin ? "" : String(u.scope || "").replace(/^\.?\/+/, "").split("/")[0];
      let nome = slug;
      if (slug && /^[A-Za-z0-9._-]+$/.test(slug)) {
        try { nome = JSON.parse(fs.readFileSync(pathLib.join(o.srvDir, slug, ".time.json"), "utf8")).nome || slug; } catch { /* usa a pasta */ }
      }
      const completo = nomes.all()[u.username.toLowerCase()] || "";
      return { usuario: u.username, nome: nomeCurto(completo, u.username), nomeCompleto: completo, admin, time: slug, timeNome: nome };
    },

    // Nome curto e completo de quem tem conta Microsoft (tela de Acessos)
    "GET /nomes": async (req) => {
      await requireAdmin(req);
      const out = {};
      for (const [email, completo] of Object.entries(nomes.all())) out[email] = { nome: completo, curto: nomeCurto(completo, email) };
      return out;
    },

    // Espaço usado: o File Browser mostra o disco da máquina para todos. Para membro, mostramos o
    // espaço do time (pasta x cota). Admin segue com a resposta nativa do File Browser.
    "GET /usage": async (req) => {
      const u = await userFromToken(req);
      if (u.perm && u.perm.admin) {
        const suffix = String(req.headers["x-orig-uri"] || "").replace(/^.*\/admin\/api\/usage/, "").split("?")[0] || "/";
        const r = await fb.asUserGet(req.headers["x-auth"], "/usage" + suffix);
        return { __raw: await r.text(), __status: r.status };
      }
      const { used, total } = quotaInfo(u, false);
      return { total, used };
    },

    // Chamado pelo NGINX (auth_request) antes de upload/gravação: recusa quando o arquivo estoura a cota
    // do time. Admin não tem limite. Leituras e remoções passam direto, sem consultar o File Browser.
    "GET /cota": async (req) => {
      const metodo = String(req.headers["x-method"] || "").toUpperCase();
      const tamanho = Number(req.headers["x-content-length"]) || Number(req.headers["x-upload-length"]) || 0;
      if (!["POST", "PUT", "PATCH"].includes(metodo) || tamanho <= 0) return { ok: true };
      const u = await userFromToken(req);
      if (u.perm && u.perm.admin) return { ok: true };
      const q = quotaInfo(u, true);
      if (!q.slug) return { ok: true };
      if (q.used + tamanho > q.total) {
        audit(u.username, "acesso_cota", `upload recusado em /${q.slug}: ${q.used + tamanho} de ${q.total} bytes`);
        throw new HttpError(403, { erro: "cota_excedida", usado: q.used, cota: q.total });
      }
      return { ok: true };
    },

    // O painel registra aqui as ações de gestão feitas na tela (promover, mover, remover...), em nome do admin
    "POST /evento": async (req) => {
      const admin = await userFromToken(req);
      if (!(admin.perm && admin.perm.admin)) throw new HttpError(403, { erro: "so_admin" });
      const b = await readBody(req);
      if (!EVENTOS_CLIENTE.has(b.evento)) throw new HttpError(400, { erro: "evento_invalido" });
      audit(admin.username, b.evento, b.detalhe);
      return { ok: true };
    },

    "GET /pedidos": async (req) => {
      await requireAdmin(req);
      return pedidos.list().map((p) => ({ ...p, curto: nomeCurto(p.nome, p.email) }));
    },

    "POST /pedidos/recusar": async (req) => {
      const admin = await userFromToken(req);
      if (!(admin.perm && admin.perm.admin)) throw new HttpError(403, { erro: "so_admin" });
      const email = String((await readBody(req)).email || "").toLowerCase();
      if (!pedidos.refuse(email)) throw new HttpError(404, { erro: "nao_encontrado" });
      audit(admin.username, "acesso_recusado", `recusou o pedido de ${email}`);
      return { ok: true };
    },

    "POST /pedidos/remover": async (req) => {
      await requireAdmin(req);
      const email = String((await readBody(req)).email || "").toLowerCase();
      pedidos.remove(email);
      return { ok: true };
    },
  };

  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, "http://x").pathname.replace(/^.*\/admin\/entra/, "") || "/";
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return send(404, { erro: "nao_encontrado" });
      if (!enabled && !["/config", "/me", "/usage"].includes(path)) return send(503, { erro: "desabilitado" });
      const out = await handler(req);
      if (out && out.__raw !== undefined) {   // resposta nativa do File Browser (admin), repassada como veio
        res.writeHead(out.__status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(out.__raw);
      }
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, e.body);
      log(`erro: ${e && e.message}`);
      send(502, { erro: "falha_interna" });
    }
  });
}

function log(msg) { console.log(`[sp-auth] ${msg}`); }

// ---------- processo ----------
function main() {
  const env = process.env;
  const base = (env.SP_BASE || "").replace(/\/$/, "");
  const tenant = (env.ENTRA_TENANT_ID || "").trim().toLowerCase();
  const clientId = (env.ENTRA_CLIENT_ID || "").trim().toLowerCase();

  const jwksLoader = env.ENTRA_JWKS_FILE
    // SÓ PARA TESTES: chaves de um arquivo local em vez do Entra
    ? async () => JSON.parse(fs.readFileSync(env.ENTRA_JWKS_FILE, "utf8"))
    : () => getJson(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);

  const app = createApp({
    tenant, clientId,
    redirectUri: env.ENTRA_REDIRECT_URI || "",
    jwksLoader,
    fbBase: `http://127.0.0.1:8080${base}/admin`,
    svc: () => {
      const [user, pass] = fs.readFileSync(env.SP_AUTH_SVC_FILE || "/run/sp-auth/svc", "utf8").split("\n");
      return { user, pass };
    },
    pedidosFile: env.SP_AUTH_PEDIDOS || "/database/entra-pedidos.json",
    srvDir: env.SP_AUTH_SRV || "/srv",
    nomesFile: env.SP_AUTH_NOMES || "/database/entra-nomes.json",
    auditFile: env.SP_AUTH_AUDITORIA || "/database/auditoria.log",
    cotaPadraoMb: env.TEAM_QUOTA_MB,
    now: () => Date.now(),
    // com arquivo de chaves de teste não há Entra para proteger: relê sem espera
    refetchCooldownMs: env.ENTRA_JWKS_FILE ? 0 : undefined,
  });
  app.listen(Number(env.SP_AUTH_PORT) || 8090, "127.0.0.1", () =>
    log(enabled(tenant, clientId) ? `Entra ID ativo (tenant ${tenant.slice(0, 8)}…)` : "Entra ID desligado (ENTRA_TENANT_ID/ENTRA_CLIENT_ID vazios)"));
}
const enabled = (t, c) => Boolean(t && c);

if (require.main === module) main();
module.exports = { createApp, createVerifier, createPedidos, nomeCurto };
