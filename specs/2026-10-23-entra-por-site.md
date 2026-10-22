# Spec: Entra ID por site (acesso restrito a e-mails autorizados)

**Status:** v1 implementada em 2026-10-23 (parecer do tech-lead incorporado; decisões do dono: seguir o recomendado). Faltam a validação com um tenant real e o modo A opcional. **Pedido por:** dono do projeto, a partir de feedback de usuários: "centralizar pode não ser a solução, tem coisa que é informação restrita".

> Há demanda real: times têm páginas com informação restrita e hoje todo site é público para quem alcança a URL. Esta spec foi escrita antes (2026-10-22) e agora vai ser implementada. **Atenção ao item "Problema central: o sandbox"**: o desenho original assumia que um cookie bastaria, e isso não vale para páginas em sandbox. O parecer do tech-lead decide a abordagem antes de codar.

## Por quê
Hoje todo site publicado é público para quem alcança a URL (o aviso está no guia `/_ajuda/`; há `noindex` e `robots.txt`). Alguns times podem querer restringir um site a pessoas específicas, com login Microsoft.

## O que seria
- Interruptor "Só com login Microsoft" por site e uma lista de e-mails autorizados, editados na tela Acessos e times.
- Site com o interruptor desligado continua como hoje (público, sem consulta extra, com cache).

## Desenho original (de 2026-10-22; vale o parecer abaixo onde divergir)
1. **Lista fora do site:** guardada em `/database` (ex.: `/database/site-acesso.json`). Os `.json` dentro de um site são públicos, então a lista de e-mails nunca fica na pasta do site.
2. **NGINX:** nos sites marcados, `auth_request` para o sp-auth (mesmo padrão da cota: `if` + `error_page` para `@location` com `auth_request`, ver MEMORY 2026-10-22). Sem cookie válido: redireciona para a página de entrada.
3. **Página de entrada** (`/_entrar/`, fora do sandbox): botão Microsoft com MSAL e o broker da home do proxy, igual ao painel (não precisa de novo registro no Entra).
4. **sp-auth:** valida o ID token (já existe em `sp-auth.js`), compara o e-mail (minúsculas) com a lista do site e grava cookie assinado (HMAC), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path` do site, validade curta (ex.: 8 h). Rota de checagem lê o cookie e consulta a lista em cache em memória.
5. **Cache HTTP:** respostas dos sites protegidos com `Cache-Control: private`.

## Custo
- **Infra:** praticamente zero. Mesmo container, nenhum serviço, banco, licença ou app Entra novos. Só os sites protegidos fazem uma consulta local por requisição (memória, milissegundos).
- **Trabalho:** médio. Rota e cookie no sp-auth, `auth_request` no NGINX, página de entrada, interface do toggle e da lista, testes E2E (Entra fake: e-mail na lista, fora da lista, cookie expirado, lista vazia, caixa alta/baixa). É a parte mais sensível do projeto em segurança.
- **Versão enxuta** (se o caso real for simples): toggle e lista por **time** (pasta de 1º nível), só admin edita. Corta cerca de metade do trabalho.

## Problema central: o sandbox e o cookie

Os sites rodam com `Content-Security-Policy: sandbox` (sem `allow-same-origin`) para que o HTML de um time não leia o token do painel (`localStorage` de `/admin`). Isso torna a **origem do documento opaca ("null")**, e para o navegador as requisições que a própria página faz (imagens, CSS, JS, `fetch` do `dados.json`) são **cross-site**:

- cookie `SameSite=Lax` (padrão) **não é enviado** nelas: a navegação para a página abre, mas **os assets e os `fetch` da página voltam 401**; o dashboard quebra;
- cookie `SameSite=None; Secure` é enviado em tags (`<img>`, `<script>`, `<link>`), mas um `fetch()` do documento opaco só devolve dados com `credentials: 'include'` **e** `Access-Control-Allow-Origin: null` + `Access-Control-Allow-Credentials: true`, o que deixaria **qualquer HTML sandboxed de outro time** ler o conteúdo restrito com o cookie do visitante (o ataque que queremos evitar);
- retirar o sandbox dos sites restritos põe o HTML deles na mesma origem do `/admin`: um editor do time roubaria o token de qualquer admin que abrir a página (escalada de privilégio).

**Opções a avaliar (tech-lead):**
- **A. Cookie `SameSite=None; Secure; HttpOnly` + checagem de `Referer`** (a página restrita responde `Referrer-Policy: unsafe-url`; o NGINX só aceita o cookie em requisições cujo `Referer` seja do mesmo site restrito; o Referer não pode ser forjado por script). CORS com credenciais só para esse caso.
- **B. Token na URL (caminho assinado):** após o login, redireciona para `/<prefixo>/_s/<token>/<site>/…`; links relativos da página herdam o token, sem cookie e sem CORS com credenciais. Contra: o link vira credencial (compartilhável, vai para histórico e logs); mitigar com validade curta, `Referrer-Policy: no-referrer` e remoção do token dos logs.
- **C. Origem separada** para sites restritos (subdomínio sem painel): resolve o sandbox de vez, mas exige DNS, certificado e mudança no proxy (fora da governança atual).
- **D. Aceitar a limitação:** páginas restritas só com conteúdo estático embutido (sem `fetch` de dados próprios) e assets por tag; documentar no guia.

Recomendação inicial (a confirmar com o tech-lead): **A**, com **D** como plano B se o Referer for inviável.

## Limites conhecidos
- (Corrigido em 2026-10-23.) O cookie só vale na **navegação**; para os assets e `fetch` da página, ver "Problema central". Um site protegido não vira API para outro site chamar.
- Protege a leitura pública, não o conteúdo para quem edita o time no painel (editores veem os arquivos).
- Visitas: decidir se a contagem de visitas conta só acessos autorizados.

## Parecer do tech-lead (2026-10-23): abordagem da v1

**Veredito:** **D com cookie `SameSite=Lax`** na v1, desenhada para a opção A entrar depois como fatia opcional. **B rejeitada** (o token no caminho cairia no `access.log` e no `visitas.log`, que vira chave pública de `/_visitas.json`, e vazaria por Referer, histórico e links encaminhados). **C** fica como saída definitiva (DNS, certificado e proxy).

**Confirmado:** cookie Lax sob sandbox só vai em **navegação** (clique, digitar a URL, `window.open`); imagens, scripts, CSS, `fetch` e iframe da página saem sem cookie. Cookie `SameSite=None` funciona em tags no Chromium com cookies de terceiros liberados, mas Safari (ITP), Firefox e janela anônima bloqueiam ou particionam: A só entra depois de uma **matriz manual** Edge/Chrome/Firefox/Safari (inclusive a política corporativa do Edge). CORS `null` + credenciais é seguro **só com** checagem de `Referer` ancorada no caminho (`/<time>/` com barra final), `Sec-Fetch-*` e `Referrer-Policy: unsafe-url` (que vaza a URL completa para terceiros: aceitável em A, desastroso em B).

**Consequência da v1:** o conteúdo restrito precisa ser **autocontido**. HTML exportado de arquivo único funciona; imagens/CSS/JS por URL relativa e `fetch('dados.json')` dão 401. Alternativa para dashboards: embutir o JSON no HTML (`<script type="application/json">`); o `publicar.py` pode ajudar.

**Dentro da v1:** toggle e lista **por time** (pasta de 1º nível); cookie `HttpOnly; Secure; SameSite=Lax; Path=<prefixo>/<time>/`; gate só na navegação; página de entrada; tratamento dos vazamentos abaixo.
**Fora da v1:** subpasta, `fetch` e assets separados, A, B, C.

**Vazamentos que a spec original não cobria (todos tratados na v1):**
1. `/_pastas/<time>/` (autoindex JSON, CORS `*`) lista nomes de arquivos: **401** se restrito.
2. `meta.json` (título e descrição do card, CORS `*`): **401** se restrito.
3. `/_visitas.json` revela existência e volume: não contar visita de site restrito (o `map` de `$sp_visita` ganha "não restrito").
4. Cache: o `location ~* \.(css|js|…)` marca `public` + 7 dias e tem precedência sobre `location /`; a exceção entra nos dois. Restrito responde `private, no-cache` (assets) ou `no-store` (HTML, por causa do bfcache), com `Vary: Cookie`. Cópias cacheadas antes de ligar o toggle continuam nos navegadores por até 7 dias.
5. Enumeração: o gate responde 401 para arquivo existente e inexistente (sem 404 diferenciado).
6. Link de compartilhamento do File Browser: editor tem `share:false`, admin tem `share:true`; um link público de share ignora a restrição (documentar).
7. Renomear ou mover a pasta restrita derrubaria a restrição se a chave fosse o caminho; com a chave por **time** (1º nível, que só o admin renomeia) isso não ocorre.
8. A existência e o nome da página/time restrito continuam públicos (home e `_pastas` da raiz).
9. Auditoria: não registrar cada 401 do gate (os assets inundariam o log); registrar a tentativa de **login** negada.

**Armazenamento e decisão barata no NGINX**
- Lista: `/database/site-acesso.json` (`{ "<time>": { "emails": [...], "por", "em" } }`), escrita atômica só pelo sp-auth, em memória e relida por mtime.
- Toggle: **arquivo-marcador** `/database/restritos/<time>`; o NGINX faz `if (-e …)` (um `stat` por requisição, sem reload e sem janela fail-open). Rejeitados: `map` gerado + reload (o sp-auth roda como `nginx`, sem poder sinalizar o master) e `auth_request` em todo asset (acopla o site público ao sp-auth).
- `default.conf`: `map $uri $sp_time` captura o 1º segmento; `if (-e /database/restritos/$sp_time) { return 418; }` repetido em `location /`, no regex de assets, em `~ ^/_pastas…`, `~ ^/.+/meta\.json$` e no `.time.json` (que continua público; a lista nunca vai nele). Para `_pastas` e `meta.json`, o 418 vai para `@restrito_aux` (401 com `cors-public.conf`, para a home ler o status).
- `@site_restrito` (padrão MEMORY 2026-10-22): `auth_request /_site_auth;`, `error_page 401 = @site_entrar` e `403 = @site_negado`, cabeçalhos próprios (`add_header` não é herdado; `no-store`/`private`, CSP sandbox + `frame-ancestors 'none'`, security headers, **sem** `cors-public.conf`), `try_files $uri $uri.html $uri/ =404;`.
- `/_site_auth` (`internal`): `proxy_pass` para `/admin/entra/site/auth` no sp-auth, sem corpo, `proxy_connect_timeout 2s`; repassa `Cookie`, `X-Orig-Uri`, `Sec-Fetch-Mode` e `Sec-Fetch-Dest`. A rota `/admin/entra/site/auth` é bloqueada por fora (`return 404` antes de `location /admin/entra/`).
- `sp-auth.js` (novas rotas): `POST /site/entrar {idToken, site}` (usa o `verify()` existente; **não** troca senha; confere a lista; emite o cookie), `GET /site/auth` (decisão do gate), `POST /site/sair`, `GET/PUT /site/acesso` (tela; só aqui o marcador é criado e removido; reconciliação no boot). `/site/entrar` entra no limite `entra`; o gate **não** leva limite por IP (RULES 24).
- Cookie: `v1.<email>.<time>.<exp>.<HMAC-SHA256>`; segredo de 32 bytes em `/database` (modo 600; apagar desloga todos); validade absoluta de 8 h, sem renovação; o gate relê a lista a cada requisição, então remover o e-mail revoga na hora.
- **Falhar fechado:** sp-auth fora do ar dá 502/504 no `auth_request` e o NGINX responde 500 sem servir conteúdo; JSON da lista ilegível nega tudo; marcador sem lista nega; o toggle só liga se o marcador foi gravado. Teste com `kill -STOP` no node (o laço reinicia em 2 s, então `kill -9` é corrida).
- **Quem acessa:** lista ∪ membros do time (usuário com e-mail e escopo no time) ∪ admins (já leem os arquivos pelo painel; lista vazia continua fazendo sentido). Cache de `fb.users()` de 30 s.

**Home e página de entrada**
- Visitante sem acesso: o card aparece com **cadeado** e "Acesso restrito"; título e descrição ficam ocultos (meta e `_pastas` dão 401 e a home trata como "restrito"); o clique abre a página de entrada. Contadores de visita do restrito não aparecem.
- Entrada = a própria resposta 401 da URL, servida de `home/entrar.html` (marcador `__SP_BASE__`), **sem** sandbox, `no-store`; sem redirect (nada de open redirect). O script faz MSAL (broker da home) e `POST site/entrar`, depois `location.reload()`; só `textContent`. Quem não está na lista: "Sua conta não tem acesso a esta página. Peça ao time responsável.", sem revelar a lista.

**Interações:** token de API **não** dá leitura de site restrito (o gate só entende o cookie; editor já lê pela API dentro do escopo). Edita a lista: editor do próprio time e admin (leitor não); todo `PUT` gera `acesso_site_lista` (quem, adicionados e removidos); a tela avisa que **dar acesso a um e-mail equivale a publicar para aquela pessoa**. Opcional `SITE_EMAIL_DOMAINS` limita os domínios aceitos na lista. Eventos: `acesso_site_entrada`, `acesso_site_negado`, `acesso_site_ligado/desligado`.

**O que não dá para garantir:** editores do time e admins leem, copiam e baixam os arquivos pelo painel; quem tem acesso pode repassar o conteúdo; cópias em navegador/proxy feitas antes do toggle; existência e nome da página e do time seguem públicos; backups e logs do container guardam o conteúdo; a v1 não protege `fetch`/assets separados.

## Critérios de aceite (v1)
- [ ] Time restrito: sem login abre a página de entrada (401); e-mail na lista abre; fora da lista vê a mensagem; lista nunca é servida publicamente.
- [ ] Um segundo time (sandboxed) não consegue ler o restrito (`<img>`, `fetch` com credenciais, iframe, `window.open`).
- [ ] `/_pastas/<time>/`, `meta.json` e `/_visitas.json` não expõem o restrito.
- [ ] Cache do restrito é `private`/`no-store` (nunca `public`); `Referrer-Policy: no-referrer`; respostas 401 com o CSP presente.
- [ ] Cookie de um time não abre outro; cookie com HMAC adulterado ou expirado volta ao 401; remover o e-mail da lista revoga na hora; caixa alta/baixa no e-mail.
- [ ] Admin e membro do time passam sem estar na lista; lista vazia: só time e admin.
- [ ] `kill -STOP` do sp-auth: restrito dá 500 e o público continua 200; JSON corrompido nega tudo.
- [ ] Latência do site público igual à de antes; ligar e desligar o toggle vale na hora.
- [ ] Home mostra o cadeado sem título/descrição; visitas do restrito não aparecem.
- [ ] Suíte E2E e unitários verdes; console sem erros nas telas novas.

## Fatias
1. sp-auth: lista, marcador, cookie, `/site/auth`, `/site/entrar`, `/site/sair` (unitários).
2. `default.conf`: map, `if`/418, `@site_restrito`, `/_site_auth` e as exceções (assets, `_pastas`, `meta.json`).
3. `entrar.html` (página de entrada).
4. Home com cadeado e filtro de visitas.
5. UI do toggle e da lista na tela Acessos, com auditoria.
6. E2E (`tests/test_site_restrito.py`, Entra fake).
7. Docs (ARCHITECTURE, RULES, MEMORY, guia, README).
8. Opcional, só após a matriz de navegadores: modo A (`SameSite=None` + Referer).

## Decisões do dono (2026-10-23): seguir o recomendado

1. v1 **só por time** e **só HTML autocontido**; o modo A fica para uma fatia posterior. ✔
2. Edge gerenciado e matriz de navegadores: **em aberto**, só importa para o modo A (não bloqueia a v1).
3. Membros do time e admins entram **sem** estar na lista. ✔
4. Editam a lista: **editores do próprio time e admin** (leitor não). ✔
5. Cookie com validade de **8 h**, sem renovação. ✔
6. Card restrito mostra **cadeado e "Acesso restrito"**, sem título e descrição, para quem não tem acesso. ✔
7. O **nome** da página/time restrito segue público. ✔

## Andamento

- 2026-10-23 — decisões do dono registradas (seguir o recomendado); spec aprovada; começando a fatia 1 (sp-auth).
- 2026-10-23 — **v1 implementada (fatias 1 a 7)**: `sp-auth` (lista, marcador, cookie HMAC de 8 h, `/site/auth`, `/site/entrar`, `/site/sair`, `/site/acesso`), NGINX (`$sp_time`, `$sp_r`, `@site_restrito`, `/_site_auth`, `@restrito_aux`), `entrar.html`, cadeado na home, tela `restrito.html` (menu para admin e editores; botão no card do time), `sp-visitas` ignora times restritos, reconcile no boot. Achados na implementação: (1) `auth_request` **não aceita variável** na URI da subrequisição e `$sp_time` é vazio nela; o gate recebe `$request_uri` em `X-Orig-Uri` e só aceita caminho limpo (sem `..`, `//`, `%`), negando o resto, para nunca divergir da normalização do NGINX; (2) `proxy_pass` com URI não vale em `location` regex nem nomeado; (3) `/database/restritos` precisa ser criado pelo entrypoint com dono `nginx`; (4) a lista de usuários do gate é cacheada por 30 s, e a **entrada** relê antes de negar (quem acabou de entrar no time). 8 E2E novos e 6 unitários.
