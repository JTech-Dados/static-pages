# Entra ID por site (ADIADA: backlog, sem implementação)

> Status: **adiada em 2026-10-22**. Escrita para não perder o desenho. Só retomar quando houver um site real com conteúdo que não pode ficar aberto a quem tem o link. Antes de implementar, reconfirmar as decisões abertas abaixo e transformar em spec ativa (`/spec`).

## Por quê
Hoje todo site publicado é público para quem alcança a URL (o aviso está no guia `/_ajuda/`; há `noindex` e `robots.txt`). Alguns times podem querer restringir um site a pessoas específicas, com login Microsoft.

## O que seria
- Interruptor "Só com login Microsoft" por site e uma lista de e-mails autorizados, editados na tela Acessos e times.
- Site com o interruptor desligado continua como hoje (público, sem consulta extra, com cache).

## Desenho proposto
1. **Lista fora do site:** guardada em `/database` (ex.: `/database/site-acesso.json`). Os `.json` dentro de um site são públicos, então a lista de e-mails nunca fica na pasta do site.
2. **NGINX:** nos sites marcados, `auth_request` para o sp-auth (mesmo padrão da cota: `if` + `error_page` para `@location` com `auth_request`, ver MEMORY 2026-10-22). Sem cookie válido: redireciona para a página de entrada.
3. **Página de entrada** (`/_entrar/`, fora do sandbox): botão Microsoft com MSAL e o mesmo Redirect URI do painel (sem novo registro no Entra, desde que a página de entrada fique no mesmo domínio).
4. **sp-auth:** valida o ID token (já existe em `sp-auth.js`), compara o e-mail (minúsculas) com a lista do site e grava cookie assinado (HMAC), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path` do site, validade curta (ex.: 8 h). Rota de checagem lê o cookie e consulta a lista em cache em memória.
5. **Cache HTTP:** respostas dos sites protegidos com `Cache-Control: private`.

## Custo
- **Infra:** praticamente zero. Mesmo container, nenhum serviço, banco, licença ou app Entra novos. Só os sites protegidos fazem uma consulta local por requisição (memória, milissegundos).
- **Trabalho:** médio. Rota e cookie no sp-auth, `auth_request` no NGINX, página de entrada, interface do toggle e da lista, testes E2E (Entra fake: e-mail na lista, fora da lista, cookie expirado, lista vazia, caixa alta/baixa). É a parte mais sensível do projeto em segurança.
- **Versão enxuta** (se o caso real for simples): toggle e lista por **time** (pasta de 1º nível), só admin edita. Corta cerca de metade do trabalho.

## Limites conhecidos
- O sandbox do site bloqueia cookies e `localStorage` dentro da página, mas o cookie de sessão é enviado pelo navegador na navegação, então o login funciona. Um site protegido não vira API para outro site chamar.
- Protege a leitura pública, não o conteúdo para quem edita o time no painel (editores veem os arquivos).
- Visitas: decidir se a contagem de visitas conta só acessos autorizados.

## Decisões abertas
1. **Granularidade:** por subpasta (recomendado, mais flexível) ou por time inteiro (mais simples).
2. **Quem edita a lista:** editores do time dentro do próprio time (recomendado) ou só admin.
3. **Validade da sessão** do cookie (sugestão: 8 h).
4. Nome do toggle e texto da tela de entrada (usar `ux-copy` da skill de marca).

## Critérios de aceite (rascunho)
1. Site sem o toggle: sem mudança de comportamento nem de desempenho.
2. Site com o toggle: sem login abre a página de entrada; com e-mail na lista abre o site e os assets; com e-mail fora da lista vê mensagem em português e nada do conteúdo.
3. Lista nunca é servida publicamente.
4. Cookie expirado ou adulterado volta à página de entrada.
5. Mudar a lista vale na próxima requisição (ou em até 1 minuto, se houver cache).
6. Tentativas negadas aparecem na Atividade.
7. Suíte completa passa, incluindo o caso em que o sp-auth está fora do ar (site protegido falha fechado, sem expor conteúdo).
