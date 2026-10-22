# Spec: cota padrão por time, espaço do time no menu, nomes curtos e card de time

**Status:** concluída
**Pedido por:** dono do repo · **Data:** 2026-10-22

## Objetivo

Dar um espaço padrão aos times, mostrar o espaço do time (e não o disco da máquina) para quem não é admin, trocar e-mail por primeiro e último nome e deixar o card de time em largura total com as pessoas num diálogo.

## Fora do escopo

- Bloquear upload acima da cota (TASKS).

## Como deve funcionar

- `TEAM_QUOTA_MB` (padrão 200) vale para times sem `cota_mb`; o card mostra "cota 200 MB (padrão)".
- Barra de espaço do menu: membro vê pasta do time x cota; admin segue com o disco.
- Nome curto (`Maria Santos`) da Microsoft, guardado no login/pedido; sem nome, deduzido do e-mail. Vale na tela de Acessos, nos pedidos e na barra superior (e-mail no tooltip).
- Card de time: largura total, resumo (pessoas, páginas, uso, visitas), cota, ações; clicar no card ou em "Pessoas" abre o diálogo com as pessoas (mover, remover, adicionar).

## Critérios de aceite

- [x] Unitários (12) e E2E (18) passam.
- [x] `/admin/api/usage/` devolve a cota do time para membro e a resposta nativa para admin.
- [x] Rotas autenticadas do sp-auth sem limite por IP; `/login` e `/solicitar` limitados.
- [x] Diálogos centralizados; números do card em uma linha.
