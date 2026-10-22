# Home, 404 e favicon servidos pela imagem

## Por quê
`content/` é só semente do `/srv`: copiada no primeiro boot e nunca mais. O servidor publicado ficou com a home do primeiro deploy (sem o link "Como publicar", visual antigo). Toda mudança na home exigia troca manual no servidor.

## Escopo
- `index.html`, `404.html` e `favicon.svg` passam a ser servidos de `/usr/share/static-pages/home/` (vêm da imagem). Cada deploy atualiza as três.
- Não há mais override por `/srv/index.html`: um `/srv/index.html` antigo continua no volume, mas fica sem efeito (senão o servidor atual manteria a home velha).
- A semente de `/srv` passa a copiar só o resto de `content/` (hoje `robots.txt`).

## Fora do escopo
Home customizável por time/servidor sem mexer no repo; mudar o conteúdo dos times em `/srv`.

## Critérios de aceite
1. `GET /` e `GET /index.html` devolvem a home da imagem, mesmo com um `/srv/index.html` diferente.
2. `GET /favicon.svg` e a página 404 vêm da imagem e respeitam `SP_BASE`.
3. A home segue sem subtítulo extra.
4. Um `/srv` vazio recebe só `robots.txt` na semente; páginas dos times seguem em `/srv`.
5. Suíte E2E e unitários passam.

## No static-pages (público)
Como o repo é um modelo e há quem edite a home pelo painel, `HOME_FROM_SRV=true` mantém o comportamento antigo (semeia e serve do `/srv`). Padrão: da imagem.
