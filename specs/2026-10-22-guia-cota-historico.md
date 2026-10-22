# Guia de publicação, cota que bloqueia, histórico de acessos e telas pequenas

## Por quê
Quem publica precisa saber as regras (sandbox, cota, visibilidade); a cota só informava; mudanças de acesso não apareciam na Atividade; o painel não tinha sido conferido em celular.

## Escopo
- Guia `/_ajuda/` linkado na home, no login e no menu Ajuda; o visual dos sites dos times é livre.
- Páginas públicas para quem tem o link: `noindex`, `robots.txt` e aviso no guia.
- Cota por time bloqueia upload (POST/PUT/PATCH tus) com 413 e mensagem em português.
- Eventos `acesso_*` na aba Atividade.
- Sem corte horizontal em 360 px.

## Fora do escopo
Backup fora da VM, Entra por site, restrição de quem vê as páginas.

## Critérios de aceite
1. `/_ajuda/` abre sem login. 2. Upload acima da cota → 413 (API e interface tus). 3. Admin não tem limite. 4. Login, pedido, aprovação, mudança de papel/time aparecem na Atividade. 5. `scrollWidth` = 360 em home, login, painel e telas de Times.
