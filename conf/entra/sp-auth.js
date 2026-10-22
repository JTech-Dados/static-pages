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
const MAX_API_TOKENS = 5;           // tokens de API ativos por pessoa
const API_DIAS = [30, 90, 365];     // validades aceitas (admin: no máximo 90)
const API_DIAS_PADRAO = 90;
const API_DIAS_ADMIN_MAX = 90;
const SITE_SESSAO_S = 8 * 3600;      // cookie de site restrito: validade absoluta, sem renovação
const MAX_EMAILS_SITE = 200;         // e-mails autorizados por time
const USERS_CACHE_MS = 30000;        // o gate não consulta o File Browser a cada asset

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

// ---------- lixeira ----------
// O hook sp-lixeira copia o que vai ser apagado para /srv/_lixeira/<dia>/<lote>/<caminho original> e anota
// uma linha em .registro (quando, quem, original, na_lixeira). Aqui o registro vira uma lista por item:
// o nome do arquivo, a pasta de onde saiu, quem apagou e quando; as pastas de data/lote não aparecem.
function createLixeira(srvDir, now = Date.now) {
  const base = pathLib.join(srvDir, "_lixeira");
  const registro = pathLib.join(base, ".registro");
  const idDe = (naLixeira) => crypto.createHash("sha256").update(naLixeira).digest("hex").slice(0, 16);
  // só caminhos limpos dentro de /srv (o registro é escrito pelo hook, mas nada vindo de arquivo é confiado)
  const limpo = (p) => typeof p === "string" && p.startsWith("/") && !/(^|\/)\.\.?(\/|$)|\/\/|\0/.test(p);

  function lerLinhas() {
    try { return fs.readFileSync(registro, "utf8").split("\n").filter(Boolean); } catch { return []; }
  }
  function entradas() {
    const out = [];
    for (const linha of lerLinhas()) {
      const [quando, quem, original, naLixeira] = linha.split("\t");
      if (!limpo(original) || !limpo(naLixeira) || !naLixeira.startsWith("/_lixeira/") || original.length < 2) continue;
      let st;
      try { st = fs.lstatSync(pathLib.join(srvDir, naLixeira)); } catch { continue; }   // expirou ou já foi apagado
      out.push({ linha, id: idDe(naLixeira), quando, quem: quem || "?", original, naLixeira, pasta: st.isDirectory() });
    }
    return out;
  }
  const grava = (linhas) => {
    const tmp = registro + ".tmp";
    fs.writeFileSync(tmp, linhas.length ? linhas.join("\n") + "\n" : "");
    fs.renameSync(tmp, registro);
  };
  // sobe a partir da pasta do item apagando o que ficou vazio (subpastas, lote e dia) (senão a lixeira acumula pastas)
  const podaVazias = (naLixeira) => {
    const partes = naLixeira.split("/").filter(Boolean);   // _lixeira, dia, lote, ...
    for (let n = partes.length - 1; n >= 2; n--) {
      try { fs.rmdirSync(pathLib.join(srvDir, ...partes.slice(0, n))); } catch { break; }
    }
  };
  const tira = (e) => grava(lerLinhas().filter((l) => l !== e.linha));

  return {
    // Itens visíveis: admin vê tudo; os demais, só o que saiu da pasta do próprio time (slug)
    list(slug, admin) {
      return entradas()
        .filter((e) => admin || (slug && e.original.startsWith(`/${slug}/`)))
        .reverse()
        .slice(0, 500)
        .map((e) => {
          const abs = pathLib.join(srvDir, e.naLixeira);
          let bytes = 0;
          try { bytes = e.pasta ? dirBytes(abs) : fs.statSync(abs).size; } catch { /* sumiu */ }
          const partes = e.original.split("/").filter(Boolean);
          return {
            id: e.id, nome: partes[partes.length - 1], pasta: "/" + partes.slice(0, -1).join("/"),
            original: e.original, time: partes[0], quem: e.quem, quando: e.quando, tipo: e.pasta ? "pasta" : "arquivo", bytes,
          };
        });
    },
    find(id, slug, admin) {
      return entradas().find((e) => e.id === id && (admin || (slug && e.original.startsWith(`/${slug}/`)))) || null;
    },
    // Devolve o item ao lugar de origem (recria a pasta de destino); se o nome já existir, ganha " (restaurado)"
    restore(e) {
      const destino = pathLib.join(srvDir, e.original);
      if (!destino.startsWith(srvDir + pathLib.sep)) throw new HttpError(400, { erro: "caminho_invalido" });
      fs.mkdirSync(pathLib.dirname(destino), { recursive: true });
      let alvo = destino;
      for (let n = 1; fs.existsSync(alvo); n++) {
        const ext = pathLib.extname(destino);
        alvo = destino.slice(0, destino.length - ext.length) + (n === 1 ? " (restaurado)" : ` (restaurado ${n})`) + ext;
      }
      fs.renameSync(pathLib.join(srvDir, e.naLixeira), alvo);
      tira(e);
      podaVazias(e.naLixeira);
      return "/" + pathLib.relative(srvDir, alvo).split(pathLib.sep).join("/");
    },
    purge(e) {
      fs.rmSync(pathLib.join(srvDir, e.naLixeira), { recursive: true, force: true });
      tira(e);
      podaVazias(e.naLixeira);
    },
  };
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
    // Login como o próprio usuário (senha recém-trocada): devolve o JWT do File Browser ou null
    async loginAs(username, password) {
      const r = await raw("POST", "/login", { body: { username, password, recaptcha: "" } });
      return r.ok ? (await r.text()).trim() : null;
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

// ---------- tokens de API pessoais ----------
// Só o SHA-256 do token fica em disco (o token tem 256 bits aleatórios: sem sal). Cada registro guarda
// o id do usuário no File Browser (usuário removido e recriado não herda tokens) e o papel que a pessoa
// tinha ao criar (o teto da sessão: promoção posterior não amplia o token).
const PAPEL_RANK = { leitor: 1, editor: 2, admin: 3 };
const papelDe = (u) => (u.perm && u.perm.admin ? "admin" : u.perm && (u.perm.create || u.perm.modify) ? "editor" : "leitor");
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function createApiTokens(file, now) {
  let data = {};
  if (file) { try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = {}; } }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  let lastSave = 0;

  function save() {
    lastSave = now();
    if (!file) return;
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o640 });
    fs.renameSync(tmp, file);
  }
  const vivo = (r) => Date.parse(r.expira) > now();
  const purge = () => { let mudou = false; for (const [h, r] of Object.entries(data)) if (!vivo(r)) { delete data[h]; mudou = true; } if (mudou) save(); };
  purge();

  return {
    find: (token) => { const r = data[hashToken(token)]; return r && vivo(r) ? r : null; },
    ofUser(usuarioId) { purge(); return Object.values(data).filter((r) => r.usuarioId === usuarioId).sort((a, b) => a.criado.localeCompare(b.criado)); },
    create(u, nome, dias, papel) {
      const token = "sp_" + crypto.randomBytes(32).toString("base64url");
      const rec = {
        id: crypto.randomBytes(6).toString("hex"), usuarioId: u.id, usuario: u.username, nome, papel,
        criado: new Date(now()).toISOString(), expira: new Date(now() + dias * 864e5).toISOString(), ultimoUso: null,
      };
      data[hashToken(token)] = rec;
      save();
      return { token, rec };
    },
    revoke(id, usuarioId) {
      const h = Object.keys(data).find((k) => data[k].id === id && data[k].usuarioId === usuarioId);
      if (!h) return null;
      const rec = data[h];
      delete data[h];
      save();
      return rec;
    },
    // ultimoUso fica em memória; vai para o disco no máximo 1 vez por minuto
    touch(rec) { rec.ultimoUso = new Date(now()).toISOString(); if (now() - lastSave > 60e3) save(); },
  };
}
const pub = (r) => ({ id: r.id, nome: r.nome, papel: r.papel, criado: r.criado, expira: r.expira, ultimoUso: r.ultimoUso });

// ---------- sites restritos (acesso por time com login Microsoft) ----------
// A lista de e-mails fica em /database (nunca na pasta do site, que é pública). O toggle é um arquivo-marcador
// restritos/<time>: o NGINX decide com um stat por requisição (sem reload e sem janela fail-open).
function createSiteAcesso(file, restritosDir, now) {
  let cache = null, mtime = -1;
  try { fs.mkdirSync(restritosDir, { recursive: true, mode: 0o755 }); } catch { /* sem pasta: o toggle falha ao ligar */ }

  // Lê a lista relendo por mtime. Arquivo ilegível ou corrompido => null (o gate nega tudo).
  function lista() {
    let st;
    try { st = fs.statSync(file); } catch { cache = {}; mtime = -1; return cache; }   // sem arquivo: sem listas
    if (st.mtimeMs === mtime && cache) return cache;
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      cache = d && typeof d === "object" && !Array.isArray(d) ? d : null;
    } catch { cache = null; }
    mtime = st.mtimeMs;
    return cache;
  }
  // alvo = "time" (o time inteiro) ou "time/pagina" (uma pasta do 1º nível do time).
  // Marcadores: <restritos>/<time> (arquivo) e <restritos>/_p/<time>/<pagina> (arquivo; "_p" não colide com
  // time porque slug de time não começa com "_").
  const marcador = (alvo) => {
    const [t, pg] = String(alvo).split("/");
    return pg === undefined ? pathLib.join(restritosDir, t) : pathLib.join(restritosDir, "_p", t, pg);
  };
  const restrito = (alvo) => fs.existsSync(marcador(alvo));

  function salvar(d) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o640 });
    fs.renameSync(tmp, file);
    mtime = -1;
  }

  return {
    restrito,
    // Quem está na lista do alvo: null = lista ilegível (nega tudo); [] = sem lista
    emails(alvo) {
      const d = lista();
      if (d === null) return null;
      const e = d[alvo] && Array.isArray(d[alvo].emails) ? d[alvo].emails : [];
      return e.map((x) => String(x).toLowerCase());
    },
    get(alvo) {
      const d = lista();
      return { ativo: restrito(alvo), emails: (d && d[alvo] && d[alvo].emails) || [], por: (d && d[alvo] && d[alvo].por) || null, em: (d && d[alvo] && d[alvo].em) || null };
    },
    // Páginas (pastas do 1º nível) restritas de um time
    paginas(time) {
      try { return fs.readdirSync(pathLib.join(restritosDir, "_p", time)); } catch { return []; }
    },
    // No boot: marcador de um time que não existe mais (pasta apagada) sai, para um time novo com o mesmo
    // nome não nascer restrito com a lista antiga. A lista guardada segue (o admin pode religar).
    reconcile(srvDir) {
      let nomes = [];
      try { nomes = fs.readdirSync(restritosDir); } catch { return; }
      for (const n of nomes) {
        if (n === "_p") continue;
        if (!fs.existsSync(pathLib.join(srvDir, n, ".time.json"))) { try { fs.unlinkSync(marcador(n)); } catch { /* já foi */ } }
      }
      // marcador de página cuja pasta não existe mais
      let times = [];
      try { times = fs.readdirSync(pathLib.join(restritosDir, "_p")); } catch { /* sem páginas restritas */ }
      for (const t of times) {
        let pgs = [];
        try { pgs = fs.readdirSync(pathLib.join(restritosDir, "_p", t)); } catch { continue; }
        for (const pg of pgs) {
          let dir = false;
          try { dir = fs.statSync(pathLib.join(srvDir, t, pg)).isDirectory(); } catch { /* sumiu */ }
          if (!dir) { try { fs.unlinkSync(marcador(`${t}/${pg}`)); } catch { /* já foi */ } }
        }
        try { fs.rmdirSync(pathLib.join(restritosDir, "_p", t)); } catch { /* ainda tem marcador */ }
      }
    },
    // Grava a lista e só depois liga o marcador: o toggle só vale se o marcador foi gravado
    set(alvo, ativo, emails, por) {
      const d = lista() || {};
      d[alvo] = { emails, por, em: new Date(now()).toISOString() };
      salvar(d);
      if (ativo) {
        fs.mkdirSync(pathLib.dirname(marcador(alvo)), { recursive: true, mode: 0o755 });
        fs.writeFileSync(marcador(alvo), "", { mode: 0o644 });
      } else {
        try { fs.unlinkSync(marcador(alvo)); } catch { /* já desligado */ }
        if (String(alvo).includes("/")) { try { fs.rmdirSync(pathLib.dirname(marcador(alvo))); } catch { /* ainda tem marcador */ } }
      }
    },
  };
}

// Segredo do HMAC dos cookies: 32 bytes aleatórios persistidos (modo 600). Apagar o arquivo desloga todos.
function createSegredo(file) {
  try { const b = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url"); if (b.length >= 32) return b; } catch { /* cria */ }
  const b = crypto.randomBytes(32);
  try { fs.writeFileSync(file, b.toString("base64url") + "\n", { mode: 0o600 }); } catch { /* sem disco: vale até reiniciar */ }
  return b;
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
  const apiTokens = createApiTokens(o.apiTokensFile, o.now);
  const sites = createSiteAcesso(o.siteAcessoFile || pathLib.join(o.srvDir || ".", "..", "site-acesso.json"), o.restritosDir || "/database/restritos", o.now);
  sites.reconcile(o.srvDir);
  const segredo = createSegredo(o.siteSegredoFile || "/database/site-segredo");
  const base = String(o.base || "").replace(/\/$/, "");
  const dominios = String(o.emailDomains || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  let usersAt = 0, usersCache = [];
  const usersCached = async (fresh) => {
    if (fresh || o.now() - usersAt > USERS_CACHE_MS) { usersCache = await fb.users(); usersAt = o.now(); }
    return usersCache;
  };
  // trocas de senha do mesmo usuário em fila: /login e /api/sessao não se atropelam
  const locks = new Map();
  const withUserLock = (key, fn) => {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  };
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

  const lixeira = createLixeira(o.srvDir || "/srv", o.now);
  // Quem pode mexer na lixeira: admin (tudo) e editor de um time (só o próprio); leitor não
  async function lixeiraUser(req) {
    const u = await userFromToken(req);
    const admin = Boolean(u.perm && u.perm.admin);
    const editor = Boolean(u.perm && (u.perm.create || u.perm.modify));
    const slug = String(u.scope || "").replace(/^\.?\/+/, "").split("/")[0];
    if (!admin && !(editor && slugOk(slug))) throw new HttpError(403, { erro: "sem_permissao" });
    return { u, slug, admin };
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

  // ---------- sites restritos: helpers ----------
  const timeDe = (v) => {
    const t = String(v || "");
    if (!slugOk(t)) throw new HttpError(400, { erro: "time_invalido" });
    if (!fs.existsSync(pathLib.join(o.srvDir, t, ".time.json"))) throw new HttpError(404, { erro: "time_inexistente" });
    return t;
  };
  const slugDoEscopo = (u) => String(u.scope || "").replace(/^\.?\/+/, "").split("/")[0];
  const podeEditarLista = (u, time) => {
    const admin = Boolean(u.perm && u.perm.admin);
    const editor = Boolean(u.perm && (u.perm.create || u.perm.modify));
    if (!(admin || (editor && slugDoEscopo(u) === time))) throw new HttpError(403, { erro: "sem_permissao" });
  };
  // Página = pasta do 1º nível do time. Nome vindo do cliente: tem de existir como pasta, sem "/", "\\" nem ponto inicial.
  const paginaDe = (time, v) => {
    const pg = String(v || "");
    if (!pg || pg.length > 200 || /[\/\\\0]/.test(pg) || pg.startsWith(".")) throw new HttpError(400, { erro: "pagina_invalida" });
    let dir = false;
    try { dir = fs.statSync(pathLib.join(o.srvDir, time, pg)).isDirectory(); } catch { /* não existe */ }
    if (!dir) throw new HttpError(404, { erro: "pagina_inexistente" });
    return pg;
  };
  // a página que o navegador mandou pode ser um arquivo da raiz do time (ex.: index.html): vale o time
  const paginaOuVazio = (time, v) => { try { return v ? paginaDe(time, v) : ""; } catch { return ""; } };
  // Alvo da restrição: a página (se ela for restrita) ou o time. Página restrita tem lista própria.
  const alvoEfetivo = (time, pagina) => (pagina && sites.restrito(`${time}/${pagina}`) ? `${time}/${pagina}` : time);
  // lista do alvo ∪ membros do time ∪ admins; lista ilegível ou marcador sem lista nega tudo (falha fechado)
  // fresh (só na entrada, que tem limite por IP): relê os usuários antes de negar, para quem acabou de entrar no time
  async function temAcesso(email, alvo, fresh) {
    const time = String(alvo).split("/")[0];
    const lista = sites.emails(alvo);
    if (lista === null) return false;
    if (lista.includes(email)) return true;
    const acha = (us) => us.find((x) => x.username.toLowerCase() === email && x.username.includes("@"));
    let u = acha(await usersCached(false));
    if (!u && fresh) u = acha(await usersCached(true));
    if (!u) return false;
    return Boolean(u.perm && u.perm.admin) || slugDoEscopo(u) === time;
  }
  const assinar = (dados) => crypto.createHmac("sha256", segredo).update(dados).digest("base64url");
  // um cookie por alvo (nome pelo hash: página pode ter espaço e acento); Path é sempre o do time, sem
  // depender de como o navegador codifica o nome da página
  const nomeCookie = (alvo) => `sp_s_${crypto.createHash("sha256").update(alvo).digest("hex").slice(0, 16)}`;
  function cookieSessao(alvo, email, apagar) {
    const nome = nomeCookie(alvo);
    const attrs = `Path=${base}/${String(alvo).split("/")[0]}/; HttpOnly; Secure; SameSite=Lax`;
    if (apagar) return `${nome}=; ${attrs}; Max-Age=0`;
    const exp = Math.floor(o.now() / 1000) + SITE_SESSAO_S;
    const corpo = Buffer.from(JSON.stringify({ e: email, t: alvo, x: exp })).toString("base64url");
    return `${nome}=v2.${corpo}.${assinar("v2." + corpo)}; ${attrs}; Max-Age=${SITE_SESSAO_S}`;
  }
  // devolve o e-mail do cookie do alvo, ou null (ausente, adulterado, de outro alvo ou expirado)
  function lerCookie(cabecalho, alvo) {
    const nome = nomeCookie(alvo);
    const par = String(cabecalho || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(nome + "="));
    if (!par) return null;
    const [v, corpo, sig] = par.slice(nome.length + 1).split(".");
    if (v !== "v2" || !corpo || !sig) return null;
    const esperado = Buffer.from(assinar("v2." + corpo)), recebido = Buffer.from(sig);
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
    try {
      const d = JSON.parse(Buffer.from(corpo, "base64url").toString());
      if (d.t !== alvo || !Number.isFinite(d.x) || d.x < Math.floor(o.now() / 1000)) return null;
      return String(d.e || "").toLowerCase() || null;
    } catch { return null; }
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
        await withUserLock(u.username, () => fb.setPassword(u.id, senha));
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

    // Quem alterou cada item de uma pasta (coluna "Alterado por"). O .autoria é dotfile e os membros têm
    // "ocultar dotfiles" ligado, então a leitura passa pelo servidor, limitada ao escopo de quem pergunta.
    // dir é relativo ao escopo do usuário. Pasta sem registro próprio herda o último autor de dentro dela.
    "GET /autoria": async (req) => {
      const u = await userFromToken(req);
      const dir = String(new URL(req.url, "http://x").searchParams.get("dir") || "").replace(/^\/+|\/+$/g, "");
      if (dir.split("/").some((x) => x === ".." || x === ".") || /[\0\\]/.test(dir)) throw new HttpError(400, { erro: "caminho_invalido" });
      const escopo = String(u.scope || "/").replace(/^\.?\/+|\/+$/g, "");
      const abs = pathLib.join(o.srvDir, escopo, dir);
      if (abs !== o.srvDir && !abs.startsWith(o.srvDir + pathLib.sep)) throw new HttpError(400, { erro: "caminho_invalido" });
      const quem = (email) => nomeCurto(nomes.all()[String(email).toLowerCase()] || "", email);
      const ler = (arq) => {
        const m = new Map();
        let txt = "";
        try { txt = fs.readFileSync(arq, "utf8"); } catch { return m; }
        for (const linha of txt.split("\n")) {
          const [nome, user, em, evento] = linha.split("\t");
          if (!nome || !user) continue;
          if (evento === "after_delete" || evento === "renamed") m.delete(nome);
          else m.set(nome, { user, em });
        }
        return m;
      };
      const out = {};
      for (const [nome, r] of ler(pathLib.join(abs, ".autoria"))) out[nome] = { por: quem(r.user), email: r.user, quando: r.em };
      let itens = [];
      try { itens = fs.readdirSync(abs, { withFileTypes: true }); } catch { /* pasta inexistente */ }
      for (const it of itens) {
        if (!it.isDirectory() || out[it.name] || it.name.startsWith("_") || it.name.startsWith(".")) continue;
        let melhor = null;
        for (const r of ler(pathLib.join(abs, it.name, ".autoria")).values()) if (!melhor || String(r.em) > String(melhor.em)) melhor = r;
        if (melhor) out[it.name] = { por: quem(melhor.user), email: melhor.user, quando: melhor.em };
      }
      return out;
    },

    // ----- lixeira: lista, restaura e apaga de vez (admin: tudo; editor: só o que saiu do próprio time) -----
    "GET /lixeira": async (req) => {
      const { u, slug, admin } = await lixeiraUser(req);
      return lixeira.list(slug, admin).map((i) => ({ ...i, quemNome: nomeCurto(nomes.all()[String(i.quem).toLowerCase()] || "", i.quem) }));
    },
    "POST /lixeira/restaurar": async (req) => {
      const { u, slug, admin } = await lixeiraUser(req);
      const e = lixeira.find(String((await readBody(req)).id || ""), slug, admin);
      if (!e) throw new HttpError(404, { erro: "nao_encontrado" });
      const destino = lixeira.restore(e);
      audit(u.username, "lixeira_restaurada", `restaurou ${e.original}${destino !== e.original ? ` como ${destino}` : ""}`);
      return { ok: true, destino };
    },
    "POST /lixeira/apagar": async (req) => {
      const { u, slug, admin } = await lixeiraUser(req);
      const e = lixeira.find(String((await readBody(req)).id || ""), slug, admin);
      if (!e) throw new HttpError(404, { erro: "nao_encontrado" });
      lixeira.purge(e);
      audit(u.username, "lixeira_apagada", `apagou de vez ${e.original}`);
      return { ok: true };
    },

    // ----- tokens de API pessoais (automações) -----
    // Cria um token para quem está logado (conta de e-mail; o admin local, sem @, só entra por senha).
    // O token aparece UMA vez; em disco fica só o hash.
    "POST /api/tokens": async (req) => {
      const u = await userFromToken(req);
      if (!u.username.includes("@")) throw new HttpError(403, { erro: "so_conta_email" });
      const b = await readBody(req);
      const nome = String(b.nome || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!nome) throw new HttpError(400, { erro: "nome_obrigatorio" });
      const dias = b.dias === undefined ? API_DIAS_PADRAO : Number(b.dias);
      const papel = papelDe(u);
      if (!API_DIAS.includes(dias) || (papel === "admin" && dias > API_DIAS_ADMIN_MAX)) throw new HttpError(400, { erro: "validade_invalida" });
      if (apiTokens.ofUser(u.id).length >= MAX_API_TOKENS) throw new HttpError(409, { erro: "limite_de_tokens" });
      const { token, rec } = apiTokens.create(u, nome, dias, papel);
      audit(u.username, "acesso_token_criado", `${nome} (${papel}, ${dias} dias)`);
      return { token, ...pub(rec) };
    },

    "GET /api/tokens": async (req) => {
      const u = await userFromToken(req);
      return apiTokens.ofUser(u.id).map(pub);
    },

    "POST /api/tokens/revogar": async (req) => {
      const u = await userFromToken(req);
      const rec = apiTokens.revoke(String((await readBody(req)).id || ""), u.id);
      if (!rec) throw new HttpError(404, { erro: "nao_encontrado" });   // inexistente ou de outra pessoa: mesma resposta
      audit(u.username, "acesso_token_revogado", rec.nome);
      return { ok: true };
    },

    // Troca o token por uma sessão do File Browser (JWT) com as permissões REAIS do dono, limitadas ao papel
    // que ele tinha ao criar o token. Pública (a credencial é o próprio token): limite por IP no NGINX.
    "POST /api/sessao": async (req) => {
      const fail = () => new HttpError(401, { erro: "token_invalido" });   // uma só resposta, sem dizer o motivo
      const token = (await readBody(req)).token;
      if (typeof token !== "string" || !token.startsWith("sp_") || token.length > 100) throw fail();
      const rec = apiTokens.find(token);
      if (!rec) throw fail();
      const jwt = await withUserLock(rec.usuario, async () => {
        const u = (await fb.users()).find((x) => x.id === rec.usuarioId && x.username === rec.usuario);
        if (!u || !u.username.includes("@")) throw fail();                       // removido, recriado ou sem e-mail
        if (PAPEL_RANK[papelDe(u)] > PAPEL_RANK[rec.papel]) throw fail();        // promovido depois: gere outro token
        for (let tentativa = 0; tentativa < 2; tentativa++) {
          const senha = crypto.randomBytes(24).toString("base64url");
          await fb.setPassword(u.id, senha);
          const t = await fb.loginAs(u.username, senha);
          if (t) return t;
        }
        throw new HttpError(502, { erro: "falha_interna" });
      });
      apiTokens.touch(rec);
      return { jwt, usuario: rec.usuario, papel: rec.papel };
    },

    // ----- sites restritos (v1: por time, cookie Lax, só navegação) -----
    // Quem pode editar a lista de um time: admin, ou editor do próprio time (leitor não).
    "GET /site/acesso": async (req) => {
      const u = await userFromToken(req);
      const q = new URL(req.url, "http://x").searchParams;
      const time = timeDe(q.get("time"));
      podeEditarLista(u, time);
      const pagina = q.get("pagina") ? paginaDe(time, q.get("pagina")) : "";
      return { ...sites.get(pagina ? `${time}/${pagina}` : time), dominios, paginas: sites.paginas(time) };
    },

    "PUT /site/acesso": async (req) => {
      const u = await userFromToken(req);
      const b = await readBody(req);
      const time = timeDe(b.time);
      podeEditarLista(u, time);
      const alvo = b.pagina ? `${time}/${paginaDe(time, b.pagina)}` : time;
      if (typeof b.ativo !== "boolean" || !Array.isArray(b.emails)) throw new HttpError(400, { erro: "pedido_invalido" });
      const emails = [...new Set(b.emails.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
      if (emails.length > MAX_EMAILS_SITE) throw new HttpError(400, { erro: "emails_demais" });
      for (const e of emails) {
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(e)) throw new HttpError(400, { erro: "email_invalido", email: e.slice(0, 80) });
        if (dominios.length && !dominios.includes(e.split("@")[1])) throw new HttpError(400, { erro: "dominio_nao_permitido", email: e.slice(0, 80) });
      }
      const antes = sites.get(alvo);
      const eraAtivo = antes.ativo;
      try { sites.set(alvo, b.ativo, emails, u.username); } catch { throw new HttpError(502, { erro: "falha_ao_gravar" }); }
      if (b.ativo && !sites.restrito(alvo)) throw new HttpError(502, { erro: "falha_ao_ligar" });   // só vale com o marcador gravado
      const add = emails.filter((e) => !antes.emails.map((x) => x.toLowerCase()).includes(e));
      const rem = antes.emails.map((x) => x.toLowerCase()).filter((e) => !emails.includes(e));
      if (add.length || rem.length) audit(u.username, "acesso_site_lista", `/${alvo}: +${add.join(",") || "-"} -${rem.join(",") || "-"}`);
      if (b.ativo !== eraAtivo) audit(u.username, b.ativo ? "acesso_site_ligado" : "acesso_site_desligado", `/${alvo}`);
      return { ok: true, ...sites.get(alvo), paginas: sites.paginas(time) };
    },

    // Entrada num site restrito: valida o ID token (sem trocar senha de ninguém) e, se a conta tem acesso,
    // emite o cookie do time. Pública (a credencial é o ID token): limite por IP no NGINX.
    "POST /site/entrar": async (req) => {
      const b = await readBody(req);
      const { email, nome } = await verify(b.idToken);
      const time = timeDe(b.site);
      const alvo = alvoEfetivo(time, paginaOuVazio(time, b.pagina));
      if (!sites.restrito(alvo)) throw new HttpError(404, { erro: "nao_restrito" });
      if (!(await temAcesso(email, alvo, true))) {
        audit(email, "acesso_site_negado", `/${alvo}`);
        throw new HttpError(403, { erro: "sem_acesso" });
      }
      nomes.set(email, nome);
      audit(email, "acesso_site_entrada", `/${alvo}`);
      return { ok: true, alvo, __cookie: cookieSessao(alvo, email) };
    },

    // Chamado pelo NGINX (auth_request) em cada requisição a um time ou página restritos. 200 = passa;
    // 401 = sem sessão válida (mostra a página de entrada); 403 = sessão válida de quem perdeu o acesso.
    // Falha fechado: URI estranha ou nada restrito no que o gate entendeu => 401 (nunca "passa").
    "GET /site/auth": async (req) => {
      // Time e página saem da URI original (X-Orig-Uri = $request_uri; o auth_request não leva variável na
      // URI da subrequisição). O NGINX decide pelo $uri (decodificado e normalizado); aqui decodifica-se igual
      // e qualquer forma que possa divergir (".." ou "." após decodificar, "//", "\\", NUL, %2f/%5c) é negada.
      let uri = String(req.headers["x-orig-uri"] || "").split("?")[0].split("#")[0];
      if (base && uri.startsWith(base + "/")) uri = uri.slice(base.length);
      let seg;
      try {
        if (/%(2f|5c|00)/i.test(uri)) throw new Error("x");
        const dec = decodeURIComponent(uri);
        if (!dec.startsWith("/") || /\/\/|\\|\0/.test(dec)) throw new Error("x");
        seg = dec.split("/").slice(1);
        if (seg.some((x) => x === ".." || x === ".")) throw new Error("x");
      } catch { throw new HttpError(401, { erro: "sem_sessao" }); }
      const time = seg[0] && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg[0]) && slugOk(seg[0]) ? seg[0] : "";
      if (!time) throw new HttpError(401, { erro: "sem_sessao" });
      const pagina = seg.length >= 2 ? seg[1] : "";   // 2º segmento (pasta ou arquivo; só pasta tem marcador)
      const alvo = alvoEfetivo(time, pagina);
      if (!sites.restrito(alvo)) throw new HttpError(401, { erro: "sem_sessao" });
      const email = lerCookie(req.headers.cookie, alvo);
      if (!email) throw new HttpError(401, { erro: "sem_sessao" });
      if (!(await temAcesso(email, alvo))) throw new HttpError(403, { erro: "sem_acesso" });
      return { ok: true };
    },

    "POST /site/sair": async (req) => {
      const b = await readBody(req);
      const time = timeDe(b.site);
      const alvo = alvoEfetivo(time, paginaOuVazio(time, b.pagina));
      return { ok: true, __cookie: cookieSessao(alvo, "", true) };
    },

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
      if (out && out.__cookie) {   // o cookie vai no cabeçalho, nunca no corpo
        const { __cookie, ...corpo } = out;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": __cookie });
        return res.end(JSON.stringify(corpo));
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
    apiTokensFile: env.SP_AUTH_API_TOKENS || "/database/api-tokens.json",
    siteAcessoFile: env.SP_AUTH_SITE_ACESSO || "/database/site-acesso.json",
    restritosDir: env.SP_AUTH_RESTRITOS || "/database/restritos",
    siteSegredoFile: env.SP_AUTH_SITE_SEGREDO || "/database/site-segredo",
    base,
    emailDomains: env.SITE_EMAIL_DOMAINS,
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
module.exports = { createApp, createLixeira, createVerifier, createPedidos, createApiTokens, nomeCurto };
