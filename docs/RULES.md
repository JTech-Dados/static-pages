# RULES — o que não pode

> Regras inegociáveis, para pessoas e para o Claude. Quebrar uma delas vaza dado ou derruba produção.

## Segredos e dados

1. **Nunca versionar** `.env`, `proxy/.env`, `backups/`, `*.db`, `auditoria.log`, `visitas.log`.
2. **Nada de dados reais em prints, testes ou docs**: nomes de pastas/pessoas reais do servidor não entram no repo. Prints do README usam dados fictícios (`divulgacao/screenshots.py`).
3. **Nunca publicar o repo** nem conteúdo com nome de empresa/cliente sem autorização explícita do dono.
4. Senha do admin na VPS: forte, 12+ caracteres, só no `.env` / variáveis do orquestrador.

## Segurança do site

5. **O CSP sandbox do site não sai sem decisão registrada** (MEMORY). Ele é o que impede um HTML enviado por upload de roubar a sessão do admin.
6. **CORS `*` só para conteúdo público do site** — nunca em rotas do `/admin`.
7. Toda rota nova que exponha algo do `/database` precisa de `auth_request` de admin ou ser deliberadamente pública (e documentada em ARCHITECTURE).
8. Pastas internas (`_lixeira`, `_backup`) e dotfiles continuam **404** no site. A única exceção é `/<time>/.time.json` do 1º nível.
9. Texto vindo de upload (nomes de pasta/arquivo, `meta.json`, `.time.json`) entra no DOM **só via `textContent`**. Nunca `innerHTML`.
10. O cadastro público de contas fica desligado (`--signup=false` no entrypoint).

## Operação

11. **Não sobrescrever conteúdo do usuário**: seed só do que ainda não existe em `/srv` (home, 404 e favicon vêm da imagem, salvo `HOME_FROM_SRV=true`); modelo de time com `override=false`; restaurar com `rename=true`.
12. Nada apagado pelo painel pode sumir sem passar pela lixeira (hook `before_delete`).
13. **Não atualizar a VPS com o CI vermelho.**
14. Versões de imagem **fixadas** (nada de `latest`). Atualizar File Browser exige rever `inject.js` e `custom.css` (seletores e caminho do binário mudam entre versões).
15. Rate limit do login fica ligado em produção. Testes não podem depender de desligá-lo.

## Código

16. Scripts `.sh` e `.conf` em **LF** (`.gitattributes`). O Dockerfile remove `\r` por garantia — não remover isso.
17. Testes E2E criam só recursos com prefixo `zz-` / `zz.` e limpam tudo (inclusive da lixeira).
18. Mudou comportamento? Atualize ARCHITECTURE/README no mesmo commit. Aprendeu algo? MEMORY no mesmo commit.
19. Commits: conventional commits em português, **sem linha de coautoria**.
20. **Nada de caminho absoluto fixo no front-end** (`/admin`, `/_pastas`…): o app pode rodar sob um prefixo (`SP_BASE`). Derive da URL, use caminho relativo ou o marcador `__SP_BASE__`.
21. **Entra ID: o servidor valida tudo.** O sp-auth confere assinatura, emissor, audiência, tenant, validade e uso único do ID token; nunca confiar em e-mail ou nome vindos do navegador. Contas de e-mail entram pela Microsoft, **inclusive admin** (quem é promovido não pode ficar trancado); o `admin` local (sem `@`) e a conta técnica `sp-svc` só entram por senha. Nenhuma senha de membro fica gravada (troca a cada login). `ENTRA_JWKS_FILE` é só de teste.
22. Endpoints públicos que criam algo no sp-auth (`/login`, `/solicitar`) ficam atrás do limite `entra` no NGINX (por IP) e com corpo ≤ 16 KB; a fila de pedidos tem teto (500). As rotas com sessão (`/me`, `/pedidos`, `/nomes`, `/usage`) **não** levam limite por IP: atrás de um proxy o IP pode ser compartilhado.
23. **Tokens de API: só o hash em disco, nunca em claro.** `/database/api-tokens.json` guarda o SHA-256; o token (`sp_…`) aparece uma vez na criação e **nunca** entra em log, no `auditoria.log` nem em resposta de erro. Cada token grava o id do usuário e o **papel de quando foi criado, que vale como teto**: promover o dono depois recusa a troca (401). O `admin` local (sem `@`) não tem token; admin por e-mail tem, com validade máxima de 90 dias. Trocas de senha do mesmo usuário (`/login` Microsoft e `/api/sessao`) passam pelo mesmo mutex.
24. **Toda escrita na API do File Browser passa pela checagem de cota**, que só enxerga o `Content-Length`: escrita em `Transfer-Encoding: chunked` recebe 411 no NGINX, e o `location = /_cota` precisa de `client_max_body_size 0` (a subrequisição herda o tamanho do upload; com o padrão de 1 MB todo envio maior dava 500).
25. **Time restrito falha fechado.** O toggle é o marcador `/database/restritos/<time>` (só vale se foi gravado); o NGINX nunca serve arquivo de time restrito sem o `auth_request` aprovar; sp-auth fora do ar, lista ilegível ou marcador sem lista negam. A lista de e-mails **nunca** vai para a pasta do site nem para o `.time.json`. O gate só aceita URI limpa (sem `..`, `//`, `%`) e o time vem do `$request_uri`, nunca de uma URI reinterpretada. Toda rota nova de conteúdo de time (nova `location` no `default.conf`) precisa do `if ($sp_r) { return 418; }` correspondente.
26. **Resposta restrita não é cacheável nem vaza por Referer:** `private, no-store`, `Vary: Cookie`, `Referrer-Policy: no-referrer`, sem `cors-public.conf`. Não registrar cada 401 do gate (os assets inundariam o log); só a tentativa de login negada (`acesso_site_negado`).
