// Testes unitários do sp-auth (login Microsoft): `node --test tests/sp-auth.test.js`
// Sem rede e sem Docker: o Entra e o File Browser são simulados.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createApp, nomeCurto } = require("../conf/entra/sp-auth.js");

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] };

const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mint(claims = {}, { key = privateKey, kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, aud: CLIENT,
    iat: now, nbf: now, exp: now + 3600, preferred_username: "Ana.Silva@Empresa.com", name: "Ana Silva",
    jti: crypto.randomUUID(), ...claims,
  };
  const head = b64u({ alg, kid, typ: "JWT" });
  const body = b64u(payload);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function setup({ clock } = {}) {
  // File Browser de mentira
  const users = [
    { id: 1, username: "admin", perm: { admin: true } },
    { id: 2, username: "sp-svc", perm: { admin: true } },
    { id: 3, username: "ana.silva@empresa.com", perm: { admin: false }, scope: "/time-a" },
    { id: 4, username: "joao", perm: { admin: false }, scope: "/time-a" },
    { id: 5, username: "chefe@empresa.com", perm: { admin: true } },
    { id: 6, username: "editor-a@empresa.com", perm: { admin: false, create: true, modify: true }, scope: "/time-a" },
    { id: 7, username: "editor-b@empresa.com", perm: { admin: false, create: true, modify: true }, scope: "/time-b" },
  ];
  const passwords = {};
  const fb = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const auth = req.headers["x-auth"];
    const url = req.url.replace("/pages/admin/api", "");
    if (req.method === "POST" && url === "/login") {
      const b = JSON.parse(body);
      if (b.username === "sp-svc" && b.password === "svc-pass") return res.end("svc-token");
      // login de usuário com a senha trocada pelo sp-auth: devolve um JWT de teste do próprio usuário
      const du = users.find((x) => x.username === b.username);
      if (du && passwords[du.id] === b.password) return res.end(`x.${b64u({ user: { id: du.id } })}.y`);
      res.statusCode = 403; return res.end();
    }
    const isAdmin = auth === "svc-token" || auth === "admin-token";
    if (req.method === "GET" && url === "/users") {
      if (!isAdmin) { res.statusCode = 403; return res.end(); }
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(users));
    }
    // token de teste "x.<payload>.y": vale para o próprio id (e para o /usage nativo)
    let tokenId = null;
    try { tokenId = JSON.parse(Buffer.from(String(auth).split(".")[1], "base64url").toString()).user.id; } catch { /* não é token de teste */ }
    const own = url.match(/^\/users\/(\d+)$/);
    if (req.method === "GET" && own && tokenId !== null && Number(own[1]) === tokenId) return res.end("{}");   // dono do token
    if (req.method === "GET" && url.startsWith("/usage") && tokenId !== null) return res.end(JSON.stringify({ total: 1000, used: 10, path: url }));
    const m = url.match(/^\/users\/(\d+)$/);
    if (req.method === "PUT" && m && auth === "svc-token") {
      const b = JSON.parse(body);
      passwords[b.data.id] = b.data.password;
      return res.end("{}");
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => fb.listen(0, "127.0.0.1", r));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-auth-"));
  const app = createApp({
    tenant: TENANT, clientId: CLIENT, redirectUri: "https://x/",
    jwksLoader: async () => jwks,
    fbBase: `http://127.0.0.1:${fb.address().port}/pages/admin`,
    svc: () => ({ user: "sp-svc", pass: "svc-pass" }),
    pedidosFile: path.join(dir, "pedidos.json"),
    srvDir: path.join(dir, "srv"),
    nomesFile: path.join(dir, "nomes.json"),
    auditFile: path.join(dir, "auditoria.log"),
    cotaPadraoMb: 200,
    apiTokensFile: path.join(dir, "api-tokens.json"),
    siteAcessoFile: path.join(dir, "site-acesso.json"),
    restritosDir: path.join(dir, "restritos"),
    siteSegredoFile: path.join(dir, "site-segredo"),
    base: "/pages",
    now: () => (clock ? clock.t : Date.now()),
  });
  fs.mkdirSync(path.join(dir, "srv", "time-a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "srv", "time-a", ".time.json"), JSON.stringify({ nome: "Time A" }));
  fs.mkdirSync(path.join(dir, "srv", "time-b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "srv", "time-b", ".time.json"), JSON.stringify({ nome: "Time B" }));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}/admin/entra`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json(), setCookie: r.headers.get("set-cookie") };
  };
  return { call, passwords, users, dir, close: () => { app.closeAllConnections(); fb.closeAllConnections(); app.close(); fb.close(); } };
}

test("config expõe só dados públicos", async () => {
  const t = await setup();
  const r = await t.call("GET", "/config");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ["authority", "clientId", "cotaPadraoMb", "habilitado", "redirectUri"]);
  assert.equal(r.data.habilitado, true);
  t.close();
});

test("login de membro: troca a senha e devolve usuário e senha", async () => {
  const t = await setup();
  const r = await t.call("POST", "/login", { idToken: mint() });
  assert.equal(r.status, 200);
  assert.equal(r.data.usuario, "ana.silva@empresa.com");
  assert.ok(r.data.senha.length >= 24);
  assert.equal(t.passwords[3], r.data.senha);
  t.close();
});

test("token inválido é recusado (assinatura, emissor, audiência, tenant, validade, idade, alg, reuso)", async () => {
  const t = await setup();
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    mint({}, { key: other.privateKey }),
    mint({ iss: "https://login.microsoftonline.com/outro/v2.0" }),
    mint({ aud: "outro-app" }),
    mint({ tid: "outro-tenant" }),
    mint({ exp: now - 3600 }),
    mint({ iat: now - 7200, exp: now + 3600 }),
    mint({}, { kid: "desconhecida" }),
    mint({ preferred_username: "sem-arroba" }),
    "a.b.c", "", "x",
  ];
  for (const token of bad) {
    const r = await t.call("POST", "/login", { idToken: token });
    assert.equal(r.status, 401, token.slice(0, 30));
  }
  // alg none
  const none = `${b64u({ alg: "none", kid: "k1" })}.${b64u({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT })}.`;
  assert.equal((await t.call("POST", "/login", { idToken: none })).status, 401);
  // reuso do mesmo token
  const ok = mint();
  assert.equal((await t.call("POST", "/login", { idToken: ok })).status, 200);
  assert.equal((await t.call("POST", "/login", { idToken: ok })).status, 401);
  t.close();
});

test("conta de e-mail admin entra pela Microsoft; conta técnica e admin local (sem @) não", async () => {
  const t = await setup();
  // admin promovido a partir de uma conta de e-mail: entra (senha trocada), para não ficar trancado
  const r = await t.call("POST", "/login", { idToken: mint({ preferred_username: "chefe@empresa.com" }) });
  assert.equal(r.status, 200);
  assert.equal(r.data.usuario, "chefe@empresa.com");
  assert.equal(t.passwords[5], r.data.senha);
  // contas sem "@" (admin local, sp-svc) nunca casam com um e-mail e não ganham senha nova
  const r2 = await t.call("POST", "/login", { idToken: mint({ preferred_username: "admin@empresa.com" }) });
  assert.equal(r2.status, 403);
  assert.equal(r2.data.erro, "sem_acesso");
  assert.equal(t.passwords[1], undefined);
  assert.equal(t.passwords[2], undefined);
  t.close();
});

test("sem acesso: pedido, status e decisão do admin", async () => {
  const t = await setup();
  const novo = () => mint({ preferred_username: "novo@empresa.com", name: "Novo Usuário" });

  // a tela chama /login e, em seguida, /solicitar com o MESMO token
  const mesmo = novo();
  let r = await t.call("POST", "/login", { idToken: mesmo });
  assert.equal(r.status, 403);
  assert.deepEqual(r.data, { erro: "sem_acesso", pedido: null });

  r = await t.call("POST", "/solicitar", { idToken: mesmo });
  assert.equal(r.status, 200);
  assert.equal(r.data.pedido, "pendente");

  r = await t.call("POST", "/login", { idToken: novo() });
  assert.equal(r.data.pedido, "pendente");

  // só admin vê e decide
  assert.equal((await t.call("GET", "/pedidos")).status, 403);
  assert.equal((await t.call("GET", "/pedidos", null, { "X-Auth": "qualquer" })).status, 403);
  r = await t.call("GET", "/pedidos", null, { "X-Auth": "admin-token" });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].email, "novo@empresa.com");
  assert.equal(r.data[0].nome, "Novo Usuário");

  assert.equal((await t.call("POST", "/pedidos/recusar", { email: "novo@empresa.com" })).status, 401);   // sem token
  assert.equal((await t.call("POST", "/pedidos/recusar", { email: "novo@empresa.com" }, { "X-Auth": `x.${b64u({ user: { id: 1 } })}.y` })).status, 200);
  r = await t.call("POST", "/login", { idToken: novo() });
  assert.equal(r.data.pedido, "recusado");
  r = await t.call("POST", "/solicitar", { idToken: novo() });
  assert.equal(r.data.pedido, "recusado");   // recusado não vira pendente de novo

  assert.equal((await t.call("POST", "/pedidos/remover", { email: "novo@empresa.com" }, { "X-Auth": "admin-token" })).status, 200);
  assert.equal((await t.call("GET", "/pedidos", null, { "X-Auth": "admin-token" })).data.length, 0);
  t.close();
});

test("quem já tem acesso não cria pedido", async () => {
  const t = await setup();
  const r = await t.call("POST", "/solicitar", { idToken: mint() });
  assert.equal(r.status, 409);
  t.close();
});

test("corpo grande ou JSON inválido", async () => {
  const t = await setup();
  assert.equal((await t.call("POST", "/login", { idToken: "x".repeat(20000) })).status, 413);   // corpo > 16 KB
  assert.equal((await t.call("POST", "/login", { idToken: "x".repeat(9000) })).status, 401);    // token > 8 KB
  t.close();
});

test("me: nome, papel e time do dono do token; token alheio ou inválido é recusado", async () => {
  const t = await setup();
  const meu = `x.${b64u({ user: { id: 4 } })}.y`;
  const r = await t.call("GET", "/me", null, { "X-Auth": meu });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { usuario: "joao", nome: "joao", nomeCompleto: "", admin: false, time: "time-a", timeNome: "Time A" });
  // token de um usuário que não existe mais (id 99): o File Browser aceita o token, mas não há conta
  assert.equal((await t.call("GET", "/me", null, { "X-Auth": `x.${b64u({ user: { id: 99 } })}.y` })).status, 401);
  assert.equal((await t.call("GET", "/me", null, { "X-Auth": "lixo" })).status, 401);
  assert.equal((await t.call("GET", "/me")).status, 401);
  t.close();
});

test("nomeCurto: primeiro e último nome; sem nome, deduz do e-mail", () => {
  assert.equal(nomeCurto("Maria Souza de Oliveira Santos"), "Maria Santos");
  assert.equal(nomeCurto("Ana"), "Ana");
  assert.equal(nomeCurto("", "maria.silva@exemplo.com"), "Maria Silva");
  assert.equal(nomeCurto("", "maria_souza-lima@x.com"), "Maria Lima");
  assert.equal(nomeCurto("", "joao"), "joao");
});

test("nomes: guardados no login e no pedido; /nomes e /me devolvem o nome curto", async () => {
  const t = await setup();
  await t.call("POST", "/login", { idToken: mint({ name: "Ana Paula da Silva Souza" }) });
  const novo = mint({ preferred_username: "novo@empresa.com", name: "Novo Da Silva Usuário" });
  await t.call("POST", "/solicitar", { idToken: novo });
  const r = await t.call("GET", "/nomes", null, { "X-Auth": "admin-token" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data["ana.silva@empresa.com"], { nome: "Ana Paula da Silva Souza", curto: "Ana Souza" });
  assert.equal(r.data["novo@empresa.com"].curto, "Novo Usuário");
  assert.equal((await t.call("GET", "/nomes")).status, 403);
  const p = await t.call("GET", "/pedidos", null, { "X-Auth": "admin-token" });
  assert.equal(p.data[0].curto, "Novo Usuário");
  // /me do usuário com e-mail e nome guardado (id 3)
  const me = await t.call("GET", "/me", null, { "X-Auth": `x.${b64u({ user: { id: 3 } })}.y` });
  assert.equal(me.data.nome, "Ana Souza");
  assert.equal(me.data.nomeCompleto, "Ana Paula da Silva Souza");
  t.close();
});

test("usage: membro vê o espaço do time (cota padrão ou do time); admin recebe o nativo; token ruim, 401", async () => {
  const t = await setup();
  const dir = path.join(t.dir, "srv", "time-a");
  fs.writeFileSync(path.join(dir, "a.html"), "x".repeat(1000));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "b.html"), "y".repeat(500));
  const joao = { "X-Auth": `x.${b64u({ user: { id: 4 } })}.y` };
  let r = await t.call("GET", "/usage", null, joao);
  assert.equal(r.status, 200);
  assert.equal(r.data.used, 1500 + Buffer.byteLength(JSON.stringify({ nome: "Time A" })));
  assert.equal(r.data.total, 200 * 1048576);   // cota padrão

  fs.writeFileSync(path.join(dir, ".time.json"), JSON.stringify({ nome: "Time A", cota_mb: 5 }));
  r = await t.call("GET", "/usage", null, joao);
  assert.equal(r.data.total, 5 * 1048576, "a cota do time vale na hora (só o tamanho da pasta tem cache de 30 s)");

  const admin = await t.call("GET", "/usage", null, { "X-Auth": `x.${b64u({ user: { id: 1 } })}.y`, "X-Orig-Uri": "/pages/admin/api/usage/sub?x=1" });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data, { total: 1000, used: 10, path: "/usage/sub" });   // resposta nativa, com o caminho original

  assert.equal((await t.call("GET", "/usage")).status, 401);
  assert.equal((await t.call("GET", "/usage", null, { "X-Auth": "lixo" })).status, 401);
  t.close();
});

test("cota: bloqueia upload que estoura a cota do time (membro); admin e leituras passam", async () => {
  const t = await setup();
  const dir = path.join(t.dir, "srv", "time-a");
  fs.writeFileSync(path.join(dir, ".time.json"), JSON.stringify({ nome: "Time A", cota_mb: 1 }));
  fs.writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(900 * 1024));   // 900 KiB de 1 MiB
  const joao = `x.${b64u({ user: { id: 4 } })}.y`;
  const chama = (extra, who = joao) => t.call("GET", "/cota", null, { "X-Auth": who, ...extra });

  assert.equal((await chama({ "X-Method": "POST", "X-Content-Length": String(50 * 1024) })).status, 200);       // cabe
  const r = await chama({ "X-Method": "POST", "X-Content-Length": String(200 * 1024) });                        // estoura
  assert.equal(r.status, 403);
  assert.equal(r.data.erro, "cota_excedida");
  assert.equal((await chama({ "X-Method": "PUT", "X-Upload-Length": String(200 * 1024) })).status, 403);       // tus
  assert.equal((await chama({ "X-Method": "POST", "X-Content-Length": "0" })).status, 200);                    // mkdir
  assert.equal((await chama({ "X-Method": "DELETE", "X-Content-Length": String(200 * 1024) })).status, 200);   // só POST/PUT contam
  t.close();
});

test("cota: admin não tem limite; token ruim em escrita grande, 401", async () => {
  const t = await setup();
  const admin = `x.${b64u({ user: { id: 1 } })}.y`;
  const grande = { "X-Method": "POST", "X-Content-Length": String(5 * 1024 * 1024 * 1024) };
  assert.equal((await t.call("GET", "/cota", null, { "X-Auth": admin, ...grande })).status, 200);
  assert.equal((await t.call("GET", "/cota", null, { "X-Auth": "lixo", ...grande })).status, 401);
  assert.equal((await t.call("GET", "/cota", null, grande)).status, 401);
  t.close();
});

test("histórico: login, pedido, recusa e eventos da tela vão para o auditoria.log; só admin registra", async () => {
  const t = await setup();
  await t.call("POST", "/login", { idToken: mint() });
  const novo = mint({ preferred_username: "novo@empresa.com", name: "Novo" });
  await t.call("POST", "/solicitar", { idToken: novo });
  const admin = { "X-Auth": `x.${b64u({ user: { id: 1 } })}.y` };
  assert.equal((await t.call("POST", "/pedidos/recusar", { email: "novo@empresa.com" }, admin)).status, 200);
  assert.equal((await t.call("POST", "/evento", { evento: "acesso_papel", detalhe: "ana agora é Admin\tcom\nquebra" }, admin)).status, 200);
  assert.equal((await t.call("POST", "/evento", { evento: "after_delete", detalhe: "x" }, admin)).status, 400);   // só eventos de acesso
  assert.equal((await t.call("POST", "/evento", { evento: "acesso_papel", detalhe: "x" }, { "X-Auth": `x.${b64u({ user: { id: 4 } })}.y` })).status, 403);   // membro
  const linhas = fs.readFileSync(path.join(t.dir, "auditoria.log"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
  assert.deepEqual(linhas.map((l) => l[2]), ["acesso_login", "acesso_pedido", "acesso_recusado", "acesso_papel"]);
  assert.equal(linhas[0][1], "ana.silva@empresa.com");
  assert.equal(linhas[2][1], "admin");
  assert.equal(linhas[3].length, 5);                       // TAB/quebra de linha no texto não quebram o formato
  assert.ok(!linhas[3][3].includes("\n"));
  t.close();
});

test("desabilitado (sem tenant/client): só /config responde", async () => {
  const app = createApp({ tenant: "", clientId: "", redirectUri: "https://x/", jwksLoader: async () => jwks, fbBase: "http://127.0.0.1:1", svc: () => ({}), pedidosFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sp-auth-")), "p.json"), now: () => Date.now() });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}/admin/entra`;
  assert.equal((await (await fetch(base + "/config")).json()).habilitado, false);
  assert.equal((await fetch(base + "/login", { method: "POST", body: "{}" })).status, 503);
  app.closeAllConnections();
  app.close();
});

// ---------- tokens de API ----------
const jwtDe = (id) => `x.${b64u({ user: { id } })}.y`;   // sessão de teste do File Browser

test("token de API: cria uma vez, guarda só o hash, lista, revoga e limita a 5", async () => {
  const t = await setup();
  const h = { "X-Auth": jwtDe(3) };
  const c = await t.call("POST", "/api/tokens", { nome: "  Job   de vendas ", dias: 90 }, h);
  assert.equal(c.status, 200);
  assert.match(c.data.token, /^sp_[A-Za-z0-9_-]{43}$/);
  assert.equal(c.data.nome, "Job de vendas");
  assert.equal(c.data.papel, "leitor");   // o usuário de teste não tem create/modify
  const disco = fs.readFileSync(path.join(t.dir, "api-tokens.json"), "utf8");
  assert.ok(!disco.includes(c.data.token), "o token em claro não pode ir para o disco");
  assert.ok(disco.includes(crypto.createHash("sha256").update(c.data.token).digest("hex")));

  const l = await t.call("GET", "/api/tokens", null, h);
  assert.equal(l.data.length, 1);
  assert.ok(!JSON.stringify(l.data).includes(c.data.token) && l.data[0].id === c.data.id);
  assert.equal((await t.call("GET", "/api/tokens", null, { "X-Auth": jwtDe(5) })).data.length, 0);   // só os do dono

  for (let i = 0; i < 4; i++) assert.equal((await t.call("POST", "/api/tokens", { nome: `t${i}` }, h)).status, 200);
  assert.equal((await t.call("POST", "/api/tokens", { nome: "6º" }, h)).status, 409);
  assert.equal((await t.call("POST", "/api/tokens", { nome: "x", dias: 7 }, h)).status, 400);
  assert.equal((await t.call("POST", "/api/tokens", { nome: " " }, h)).status, 400);

  // revogar token de outra pessoa: mesma resposta de "não existe"; o dono revoga
  assert.equal((await t.call("POST", "/api/tokens/revogar", { id: c.data.id }, { "X-Auth": jwtDe(5) })).status, 404);
  assert.equal((await t.call("POST", "/api/tokens/revogar", { id: c.data.id }, h)).status, 200);
  assert.equal((await t.call("POST", "/api/sessao", { token: c.data.token })).status, 401);
  assert.equal((await t.call("GET", "/api/tokens", null, h)).data.length, 4);
  t.close();
});

test("token de API: quem pode ter (admin local não; admin por e-mail com validade ≤ 90 dias)", async () => {
  const t = await setup();
  assert.equal((await t.call("POST", "/api/tokens", { nome: "x" }, { "X-Auth": jwtDe(1) })).status, 403);   // admin local, sem @
  const chefe = { "X-Auth": jwtDe(5) };
  assert.equal((await t.call("POST", "/api/tokens", { nome: "x", dias: 365 }, chefe)).data.erro, "validade_invalida");
  const ok = await t.call("POST", "/api/tokens", { nome: "x", dias: 90 }, chefe);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.papel, "admin");
  assert.equal((await t.call("POST", "/api/tokens", { nome: "x" })).status, 401);   // sem sessão
  t.close();
});

test("token de API: troca por sessão do File Browser (e recusa token ruim, expirado, removido, promovido)", async () => {
  const clock = { t: Date.now() };
  const t = await setup({ clock });
  const h = { "X-Auth": jwtDe(3) };
  const { data } = await t.call("POST", "/api/tokens", { nome: "job", dias: 30 }, h);

  const s = await t.call("POST", "/api/sessao", { token: data.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.usuario, "ana.silva@empresa.com");
  assert.equal(s.data.jwt, jwtDe(3));                       // JWT do próprio usuário
  assert.ok(typeof t.passwords[3] === "string" && t.passwords[3].length >= 24);

  const ruim = [{ token: "sp_" + "a".repeat(43) }, { token: "xyz" }, { token: 5 }, {}, { token: "sp_" + "a".repeat(200) }];
  for (const b of ruim) assert.deepEqual((await t.call("POST", "/api/sessao", b)).data, { erro: "token_invalido" });

  // promoção depois de criar: o token não amplia o papel
  t.users[2].perm = { admin: true };
  assert.equal((await t.call("POST", "/api/sessao", { token: data.token })).status, 401);
  t.users[2].perm = { admin: false, create: true };   // virou Editor: acima do Leitor gravado
  assert.equal((await t.call("POST", "/api/sessao", { token: data.token })).status, 401);
  t.users[2].perm = { admin: false };

  // rebaixar mantém a troca (com o papel menor); removido e recriado com outro id perde os tokens
  const { data: d2 } = await t.call("POST", "/api/tokens", { nome: "ed" }, { "X-Auth": jwtDe(5) });
  t.users[4].perm = { admin: false, create: true };   // admin rebaixado a Editor
  assert.equal((await t.call("POST", "/api/sessao", { token: d2.token })).status, 200);
  t.users[2].id = 99;
  assert.equal((await t.call("POST", "/api/sessao", { token: data.token })).status, 401);
  t.users[2].id = 3;

  // expira
  clock.t += 31 * 864e5;
  assert.equal((await t.call("POST", "/api/sessao", { token: data.token })).status, 401);

  // corpo grande
  const big = await t.call("POST", "/api/sessao", { token: "sp_" + "a".repeat(20000) });
  assert.equal(big.status, 413);
  t.close();
});

test("token de API: trocas simultâneas do mesmo usuário e /login Microsoft não se atropelam", async () => {
  const t = await setup();
  const { data } = await t.call("POST", "/api/tokens", { nome: "job" }, { "X-Auth": jwtDe(3) });
  const rs = await Promise.all(Array.from({ length: 8 }, () => t.call("POST", "/api/sessao", { token: data.token })));
  assert.deepEqual(rs.map((r) => r.status), Array(8).fill(200));
  assert.ok(rs.every((r) => r.data.jwt === jwtDe(3)));
  const mix = await Promise.all([
    t.call("POST", "/api/sessao", { token: data.token }),
    t.call("POST", "/login", { idToken: mint() }),
    t.call("POST", "/api/sessao", { token: data.token }),
  ]);
  assert.deepEqual(mix.map((r) => r.status), [200, 200, 200]);
  t.close();
});

test("token de API: nenhum token em claro vai para o histórico nem para o disco", async () => {
  const t = await setup();
  const { data } = await t.call("POST", "/api/tokens", { nome: "job" }, { "X-Auth": jwtDe(3) });
  await t.call("POST", "/api/sessao", { token: data.token });
  await t.call("POST", "/api/tokens/revogar", { id: data.id }, { "X-Auth": jwtDe(3) });
  const log = fs.readFileSync(path.join(t.dir, "auditoria.log"), "utf8");
  assert.match(log, /acesso_token_criado/);
  assert.match(log, /acesso_token_revogado/);
  for (const f of fs.readdirSync(t.dir)) {
    const p = path.join(t.dir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, "utf8").includes(data.token), `token em claro em ${f}`);
  }
  t.close();
});

// ---------- sites restritos (por time) ----------
const cookieDe = (r) => (r.setCookie || "").split(";")[0];   // "nome=valor" para reenviar no gate

async function ligaRestrito(t, emails = ["convidada@empresa.com"], quem = 6) {
  const r = await t.call("PUT", "/site/acesso", { time: "time-a", ativo: true, emails }, { "X-Auth": jwtDe(quem) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}
// o NGINX passa a URI original em X-Orig-Uri ($request_uri, com o prefixo público)
const gate = (t, uri, cookie) => t.call("GET", "/site/auth", null, { "X-Orig-Uri": "/pages" + uri, ...(cookie ? { Cookie: cookie } : {}) });

test("site restrito: quem edita a lista (admin e editor do próprio time; leitor e outro time não)", async () => {
  const t = await setup();
  const body = { time: "time-a", ativo: true, emails: ["Ana@Empresa.com", " ana@empresa.com ", "joao@empresa.com"] };
  assert.equal((await t.call("PUT", "/site/acesso", body, { "X-Auth": jwtDe(3) })).status, 403);   // leitor do time
  assert.equal((await t.call("PUT", "/site/acesso", body, { "X-Auth": jwtDe(7) })).status, 403);   // editor de outro time
  assert.equal((await t.call("PUT", "/site/acesso", body)).status, 401);
  const ok = await t.call("PUT", "/site/acesso", body, { "X-Auth": jwtDe(6) });                     // editor do time
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.emails, ["ana@empresa.com", "joao@empresa.com"]);                         // minúsculas, sem duplicata
  assert.ok(fs.existsSync(path.join(t.dir, "restritos", "time-a")), "o marcador liga o toggle");
  assert.equal((await t.call("GET", "/site/acesso?time=time-a", null, { "X-Auth": jwtDe(5) })).data.ativo, true);   // admin lê
  assert.equal((await t.call("GET", "/site/acesso?time=time-a", null, { "X-Auth": jwtDe(7) })).status, 403);

  // validação
  const h = { "X-Auth": jwtDe(6) };
  assert.equal((await t.call("PUT", "/site/acesso", { ...body, emails: ["sem-arroba"] }, h)).data.erro, "email_invalido");
  assert.equal((await t.call("PUT", "/site/acesso", { ...body, time: "../etc" }, h)).status, 400);
  assert.equal((await t.call("PUT", "/site/acesso", { ...body, time: "time-z" }, h)).status, 404);
  assert.equal((await t.call("PUT", "/site/acesso", { time: "time-a", ativo: "sim", emails: [] }, h)).status, 400);
  assert.equal((await t.call("PUT", "/site/acesso", { ...body, emails: Array.from({ length: 201 }, (_, i) => `p${i}@empresa.com`) }, h)).data.erro, "emails_demais");

  // desligar remove o marcador e mantém a lista
  const off = await t.call("PUT", "/site/acesso", { ...body, ativo: false }, h);
  assert.equal(off.data.ativo, false);
  assert.equal(off.data.emails.length, 2);
  assert.ok(!fs.existsSync(path.join(t.dir, "restritos", "time-a")));
  const log = fs.readFileSync(path.join(t.dir, "auditoria.log"), "utf8");
  assert.match(log, /acesso_site_lista.*\+ana@empresa.com,joao@empresa.com/);
  assert.match(log, /acesso_site_ligado/);
  assert.match(log, /acesso_site_desligado/);
  t.close();
});

test("site restrito: entrada com ID token (lista, membro do time e admin; fora disso, não)", async () => {
  const t = await setup();
  await ligaRestrito(t, ["convidada@empresa.com"]);
  const entrar = (email) => t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: email }), site: "time-a" });

  const conv = await entrar("Convidada@Empresa.com");                       // na lista (caixa alta)
  assert.equal(conv.status, 200);
  assert.match(conv.setCookie, /^sp_s_time-a=v1\./);
  assert.match(conv.setCookie, /HttpOnly/);
  assert.match(conv.setCookie, /Secure/);
  assert.match(conv.setCookie, /SameSite=Lax/);
  assert.match(conv.setCookie, /Path=\/pages\/time-a\//);
  assert.match(conv.setCookie, /Max-Age=28800/);
  assert.ok(!JSON.stringify(conv.data).includes("v1."), "o cookie não vai no corpo");

  assert.equal((await entrar("ana.silva@empresa.com")).status, 200);       // membro do time, fora da lista
  assert.equal((await entrar("chefe@empresa.com")).status, 200);           // admin
  const negado = await entrar("estranha@empresa.com");
  assert.equal(negado.status, 403);
  assert.equal(negado.setCookie, null);
  assert.equal((await entrar("editor-b@empresa.com")).status, 403);        // membro de OUTRO time
  assert.equal((await t.call("POST", "/site/entrar", { idToken: "lixo", site: "time-a" })).status, 401);
  assert.equal((await t.call("POST", "/site/entrar", { idToken: mint(), site: "time-b" })).status, 404);   // time-b não é restrito
  assert.match(fs.readFileSync(path.join(t.dir, "auditoria.log"), "utf8"), /acesso_site_negado\t\/time-a/);
  t.close();
});

test("site restrito: o gate (cookie válido, adulterado, expirado, de outro time, acesso removido)", async () => {
  const clock = { t: Date.now() };
  const t = await setup({ clock });
  await ligaRestrito(t, ["convidada@empresa.com"]);
  const cookie = cookieDe(await t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: "convidada@empresa.com" }), site: "time-a" }));

  assert.equal((await gate(t, "/time-a/relatorio/", cookie)).status, 200);
  assert.equal((await gate(t, "/time-a/", cookie)).status, 200);
  assert.equal((await gate(t, "/time-a/relatorio/")).status, 401);                          // sem cookie
  assert.equal((await gate(t, "/time-a/", cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status, 401);   // HMAC adulterado
  assert.equal((await gate(t, "/time-a/", "sp_s_time-a=lixo")).status, 401);
  assert.equal((await gate(t, "/", cookie)).status, 401);                                    // sem time na URI
  // URIs que o NGINX normalizaria de outro jeito são negadas, nunca reinterpretadas (sem desvio por "..", "//", "%")
  for (const feio of ["/time-b/../time-a/", "/time-a/%2e%2e/", "//time-a/", "/./time-a/", "/time%2da/", "/time-b/..%2ftime-a/"]) {
    assert.equal((await gate(t, feio, cookie)).status, 401, feio);
  }
  assert.equal((await gate(t, "/time-a/x?y=../z", cookie)).status, 200);                    // query não conta
  assert.equal((await t.call("GET", "/site/auth", null, { "X-Orig-Uri": "/time-a/", Cookie: cookie })).status, 200);   // sem prefixo (acesso direto)
  // cookie de um time não abre o outro (mesmo se o outro fosse restrito)
  const outro = await t.call("PUT", "/site/acesso", { time: "time-b", ativo: true, emails: [] }, { "X-Auth": jwtDe(7) });
  assert.equal(outro.status, 200);
  assert.equal((await gate(t, "/time-b/", cookie.replace("sp_s_time-a", "sp_s_time-b"))).status, 401);

  // remover o e-mail da lista revoga na hora (o cookie continua válido, mas a lista é relida)
  await t.call("PUT", "/site/acesso", { time: "time-a", ativo: true, emails: [] }, { "X-Auth": jwtDe(6) });
  assert.equal((await gate(t, "/time-a/", cookie)).status, 403);

  // membros e admin passam com a lista vazia
  const membro = cookieDe(await t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: "ana.silva@empresa.com" }), site: "time-a" }));
  assert.equal((await gate(t, "/time-a/", membro)).status, 200);

  // expira em 8 h, sem renovação
  clock.t += 8 * 3600e3 + 1500;
  assert.equal((await gate(t, "/time-a/", membro)).status, 401);
  t.close();
});

test("site restrito: falha fechado (lista corrompida, marcador sem lista) e time público passa", async () => {
  const t = await setup();
  await ligaRestrito(t, ["convidada@empresa.com"]);
  const cookie = cookieDe(await t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: "convidada@empresa.com" }), site: "time-a" }));
  assert.equal((await gate(t, "/time-a/", cookie)).status, 200);

  fs.writeFileSync(path.join(t.dir, "site-acesso.json"), "{ isto não é json");
  assert.equal((await gate(t, "/time-a/", cookie)).status, 403);                             // lista ilegível: nega tudo
  const membro = cookieDe(await t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: "ana.silva@empresa.com" }), site: "time-a" }));
  assert.equal(membro, "");                                                                    // nem a entrada abre
  fs.rmSync(path.join(t.dir, "site-acesso.json"));
  assert.equal((await gate(t, "/time-a/", cookie)).status, 403);                             // marcador sem lista: nega
  // time sem marcador: o gate não restringe
  assert.equal((await gate(t, "/time-b/", "")).status, 200);
  t.close();
});

test("site restrito: sair apaga o cookie; o segredo é persistido em modo 600 e invalida tudo se apagado", async () => {
  const t = await setup();
  await ligaRestrito(t, ["convidada@empresa.com"]);
  const cookie = cookieDe(await t.call("POST", "/site/entrar", { idToken: mint({ preferred_username: "convidada@empresa.com" }), site: "time-a" }));
  const sair = await t.call("POST", "/site/sair", { site: "time-a" });
  assert.match(sair.setCookie, /sp_s_time-a=;.*Max-Age=0/);
  const segredo = path.join(t.dir, "site-segredo");
  assert.equal(fs.statSync(segredo).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(segredo, "utf8").includes(cookie.split("=")[1]));
  t.close();
});

test("site restrito: no boot, marcador de time que não existe mais é removido (a lista guardada segue)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-rec-"));
  fs.mkdirSync(path.join(dir, "srv", "vivo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "srv", "vivo", ".time.json"), "{}");
  fs.mkdirSync(path.join(dir, "restritos"));
  fs.writeFileSync(path.join(dir, "restritos", "vivo"), "");
  fs.writeFileSync(path.join(dir, "restritos", "apagado"), "");
  fs.writeFileSync(path.join(dir, "site-acesso.json"), JSON.stringify({ apagado: { emails: ["a@x.com"] } }));
  const app = createApp({
    tenant: TENANT, clientId: CLIENT, redirectUri: "https://x/", jwksLoader: async () => jwks, fbBase: "http://127.0.0.1:1/x",
    svc: () => ({ user: "u", pass: "p" }), pedidosFile: path.join(dir, "p.json"), srvDir: path.join(dir, "srv"), nomesFile: path.join(dir, "n.json"),
    auditFile: path.join(dir, "a.log"), siteAcessoFile: path.join(dir, "site-acesso.json"), restritosDir: path.join(dir, "restritos"),
    siteSegredoFile: path.join(dir, "seg"), now: () => Date.now(),
  });
  assert.ok(fs.existsSync(path.join(dir, "restritos", "vivo")));
  assert.ok(!fs.existsSync(path.join(dir, "restritos", "apagado")));
  assert.ok(fs.readFileSync(path.join(dir, "site-acesso.json"), "utf8").includes("a@x.com"));
  app.close();
});

