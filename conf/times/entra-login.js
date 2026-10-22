// ============================================================
// Botão "Entrar com Microsoft" na tela de login do painel.
// Carregado pelo inject.js só em <prefixo>/admin/login.
//
//   1. GET  entra/config     -> clientId, authority, redirectUri (ou habilitado:false)
//   2. MSAL (popup); Redirect URI = ENTRA_REDIRECT_URI ou, se vazio, a página <prefixo>/admin/entra/retorno -> ID token
//   3. POST entra/login      -> { usuario, senha } se a conta tem acesso
//        a senha é aleatória e vale uma vez: preenchemos o formulário NATIVO
//        do File Browser e enviamos (token, cookies e permissões normais)
//      403 sem_acesso        -> oferece "Solicitar acesso" (POST entra/solicitar)
//
// Todo texto entra via textContent. Admin não entra por aqui (senha local).
// ============================================================
(function () {
  "use strict";
  if (window.__spEntraLogin) return;
  window.__spEntraLogin = true;

  const BASE = location.pathname.replace(/\/admin(\/.*)?$/, "");
  const ENTRA = BASE + "/admin/entra";
  let config = null;
  let msalApp = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const post = async (path, body) => {
    const r = await fetch(ENTRA + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = {};
    try { data = await r.json(); } catch (_) { /* sem corpo */ }
    return { status: r.status, data };
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Não foi possível carregar o login Microsoft."));
      document.head.append(s);
    });
  }

  async function microsoftIdToken() {
    if (!window.msal) await loadScript(BASE + "/admin/times/msal-browser.min.js");
    if (!msalApp) {
      msalApp = new window.msal.PublicClientApplication({
        auth: { clientId: config.clientId, authority: config.authority, redirectUri: config.redirectUri || (location.origin + ENTRA + "/retorno"), navigateToLoginRequestUrl: false },
        cache: { cacheLocation: "sessionStorage" },
      });
      await msalApp.initialize();
    }
    const res = await msalApp.loginPopup({ scopes: ["openid", "profile", "email"], prompt: "select_account" });
    return { idToken: res.idToken, email: (res.account && res.account.username) || "" };
  }

  // Preenche o formulário nativo (campos controlados pelo Vue: precisa do evento input)
  function submitNativeLogin(form, usuario, senha) {
    const set = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(form.querySelector("input[type=text]"), usuario);
    set(form.querySelector("input[type=password]"), senha);
    const submit = form.querySelector("input[type=submit], button[type=submit]");
    if (submit) submit.click(); else form.requestSubmit();
  }

  // Logo da Microsoft (quatro quadrados), como nos botões de login das outras apps do portal
  function msLogo() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 21 21");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    [[1, 1, "#F25022"], [11, 1, "#7FBA00"], [1, 11, "#00A4EF"], [11, 11, "#FFB900"]].forEach(([x, y, fill]) => {
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", "9"); r.setAttribute("height", "9"); r.setAttribute("fill", fill);
      svg.append(r);
    });
    return svg;
  }

  function build(form) {
    // Mesma ordem das outras apps: botão Microsoft, "ou com usuário e senha", campos
    const box = el("div", "sp-entra");
    const btn = el("button", "button button--flat");
    btn.type = "button";
    btn.append(msLogo(), el("span", null, "Entrar com Microsoft"));
    const msg = el("p", "sp-entra-msg");
    msg.setAttribute("role", "status");
    msg.hidden = true;
    const extra = el("div", "sp-entra-extra");
    const sep = el("p", "sp-entra-sep", "ou com usuário e senha");
    box.append(btn, msg, extra, sep);
    const anchor = form.querySelector("label") || form.querySelector("input");
    if (anchor) form.insertBefore(box, anchor); else form.append(box);

    const say = (text, isError) => { msg.textContent = text; msg.hidden = !text; msg.classList.toggle("sp-entra-error", Boolean(isError)); };

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      extra.replaceChildren();
      say("Abrindo o login da Microsoft…");
      try {
        const { idToken, email } = await microsoftIdToken();
        say("Conferindo seu acesso…");
        const r = await post("/login", { idToken });
        if (r.status === 200) {
          say("Entrando…");
          submitNativeLogin(form, r.data.usuario, r.data.senha);
          return;
        }
        if (r.status === 403 && r.data.erro === "sem_acesso") {
          noAccess(email, r.data.pedido, idToken);
        } else if (r.status === 403 && r.data.erro === "so_senha") {
          say("Esta conta entra com usuário e senha, não pela Microsoft.", true);
        } else if (r.status === 429) {
          say("Muitas tentativas. Aguarde um minuto.", true);
        } else {
          say("Não foi possível validar o login da Microsoft. Tente de novo.", true);
        }
      } catch (e) {
        const text = String((e && e.message) || e);
        say(/popup|blocked|interaction_in_progress/i.test(text)
          ? "O navegador bloqueou a janela da Microsoft. Libere pop-ups para este site e tente de novo."
          : /user_cancelled|cancel/i.test(text) ? "Login cancelado." : "Não foi possível entrar com a Microsoft.", true);
      } finally {
        btn.disabled = false;
      }

      function noAccess(email, pedido, idToken) {
        const who = email ? ` (${email})` : "";
        if (pedido === "pendente") return say(`Sua conta${who} já tem um pedido de acesso em análise. Avise o administrador.`);
        if (pedido === "recusado") return say(`O pedido de acesso da sua conta${who} foi recusado. Fale com o administrador.`, true);
        say(`Sua conta${who} ainda não tem acesso ao Pages.`);
        const ask = el("button", "button button--blue", "Solicitar acesso");
        ask.type = "button";
        ask.addEventListener("click", async () => {
          ask.disabled = true;
          const s = await post("/solicitar", { idToken }).catch(() => ({ status: 0, data: {} }));
          if (s.status === 200 || s.status === 202) {
            extra.replaceChildren();
            say("Pedido enviado. Um administrador vai avaliar e indicar o seu time.");
          } else if (s.status === 401) {
            ask.disabled = false;
            say("O login expirou. Clique em Entrar com Microsoft e peça de novo.", true);
          } else if (s.status === 409) {
            say("Sua conta já tem acesso. Entre de novo com a Microsoft.");
          } else {
            ask.disabled = false;
            say("Não foi possível enviar o pedido. Tente de novo.", true);
          }
        });
        extra.append(ask);
      }
    });
  }

  async function init() {
    try {
      const r = await fetch(ENTRA + "/config", { cache: "no-store" });
      config = r.ok ? await r.json() : null;
    } catch (_) { config = null; }
    if (!config || !config.habilitado) return;

    const place = () => {
      const form = document.querySelector("#login form");
      if (form && !form.querySelector(".sp-entra")) build(form);
    };
    new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
    place();
  }
  init();
})();
