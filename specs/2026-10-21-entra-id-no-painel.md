# Spec: login Microsoft (Entra ID) no painel

**Status:** concluída (falta validar o popup do MSAL com um tenant real)
**Pedido por:** dono do repo · **Data:** 2026-10-21

## Objetivo

Membros entram no `/admin/` com a conta Microsoft corporativa. Quem não tem acesso pede e o admin aprova, escolhendo o time. Admin continua só com usuário e senha.

## Fora do escopo

- Entra ID por site (toggle por página, lista de e-mails em `.json`): ideia futura, ver TASKS.
- Admin via Microsoft; grupos do AD; SSO entre as apps do portal.

## Como deve funcionar

- Tela de login: botão "Entrar com Microsoft" no topo, "ou com usuário e senha" e os campos (mesma ordem das outras apps do portal). Só aparece com `ENTRA_TENANT_ID` e `ENTRA_CLIENT_ID`.
- MSAL (popup) com o Redirect URI `<prefixo>/admin/entra/retorno` (ou `ENTRA_REDIRECT_URI`) devolve o ID token; o `sp-auth` valida no servidor.
- E-mail cadastrado (usuário do File Browser com "@", não admin): senha trocada por uma aleatória e usada no formulário nativo. Outro e-mail: "sem acesso" + "Solicitar acesso" (pedido pendente/recusado, sem spam).
- Menu **Acessos** (antes "Times"), com aba **Pedidos** (escolher time e aprovar, recusar, remover); barra superior com nome, time e papel, e aviso amarelo de pedidos pendentes para o admin em qualquer tela e opção **Conta Microsoft** em "Adicionar pessoa".
- Admin não entra pela Microsoft (mensagem pedindo usuário e senha).

## Onde mexe

- [x] NGINX (`/admin/entra/`, limite `entra`, login burst 10) · [x] Entrypoint (conta `sp-svc`, laço do sp-auth) · [x] Dockerfile (nodejs, `sp-auth.js`)
- [x] Painel: `entra-login.js`, `msal-browser.min.js`, `inject.js`, `times.html`, `times-tabs.js`, `custom.css`
- [x] Compose / `.env.example` / CI · [x] Testes: `tests/sp-auth.test.js` (8), `tests/test_entra.py` (5)
- [x] Docs

## Critérios de aceite

- [x] Token com assinatura, emissor, audiência, tenant, validade, idade ou alg errados, ou reutilizado: 401.
- [x] Membro cadastrado entra; senha devolvida abre o painel restrito ao time.
- [x] Admin e usuário sem "@" recebem `so_senha`.
- [x] Pedido de acesso: cria, não duplica, recusado não volta a pendente, aprovação na tela cria o usuário e remove o pedido.
- [x] `/admin/entra/pedidos*` só para admin.
- [x] Sem `ENTRA_*`: botão e abas escondidos, endpoints 503.
- [x] Suíte completa passa com `SP_BASE=/pages`.
- [ ] Popup real da Microsoft (MSAL) validado com um tenant real.
