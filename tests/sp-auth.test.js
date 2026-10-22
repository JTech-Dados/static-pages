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

async function setup() {
  // File Browser de mentira
  const users = [
    { id: 1, username: "admin", perm: { admin: true } },
    { id: 2, username: "sp-svc", perm: { admin: true } },
    { id: 3, username: "ana.silva@empresa.com", perm: { admin: false }, scope: "/time-a" },
    { id: 4, username: "joao", perm: { admin: false }, scope: "/time-a" },
    { id: 5, username: "chefe@empresa.com", perm: { admin: true } },
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
    now: () => Date.now(),
  });
  fs.mkdirSync(path.join(dir, "srv", "time-a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "srv", "time-a", ".time.json"), JSON.stringify({ nome: "Time A" }));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}/admin/entra`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
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
