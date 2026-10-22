# Pedir acesso a uma página restrita

**Status:** concluída (2026-10-22)

## Problema
Quem entra com a conta Microsoft numa página restrita e não está na lista só vê "não tem acesso". Não há como pedir: depende de alguém saber a quem procurar (o contato opcional resolve só em parte).

## Decisões (recomendadas)
- Botão **Pedir acesso** na tela de entrada, só depois de um login Microsoft válido que foi negado (a credencial é o ID token; nada de formulário anônimo).
- O pedido vale para o **alvo efetivo** (página ou time) e fica em `/database/site-pedidos.json` (nunca na pasta do site).
- Quem aprova: admin e editor do time. Vê os pedidos na tela **Acesso restrito** (seção "Pedidos de acesso") e um contador no item do menu. **Sem e-mail** (não há SMTP): aviso só dentro do painel.
- **Aprovar** acrescenta o e-mail à lista do alvo e remove o pedido; **Recusar** marca o pedido; a mesma pessoa só pede de novo depois de 24 h.
- Limites: um pedido pendente por (alvo, e-mail); até 100 pedidos pendentes por alvo; 20 por e-mail; rota pública atrás do limite `entra` do NGINX e corpo ≤ 16 KB.
- Auditoria: `acesso_site_pedido`, `acesso_site_aprovado`, `acesso_site_recusado` (Atividade).

## Fora do escopo
E-mail ou Teams para avisar; mensagem livre do solicitante (só nome e e-mail do token); expirar pedidos antigos além da recusa de 24 h.

## Onde mexe
`conf/entra/sp-auth.js` (`createSitePedidos`, rotas `POST /site/pedir`, `GET /site/pedidos`, `POST /site/pedidos/decidir`, `GET /site/pedidos/pendentes`), `conf/nginx/default.conf` (limite), `content/entrar.html` (botão), `conf/times/restrito.html` (seção), `conf/times/inject.js` (contador), testes e docs.

## Critérios de aceite
1. Negado no login Microsoft vê "Pedir acesso"; clicar cria um pedido e mostra confirmação; clicar de novo não duplica.
2. Quem já tem acesso (lista, membro, admin) não cria pedido.
3. Editor do time e admin listam os pedidos do time; editor de outro time e leitor recebem 403.
4. Aprovar põe o e-mail na lista do alvo e a pessoa passa a entrar; recusar bloqueia novo pedido por 24 h.
5. Sem ID token válido não existe pedido; o pedido nunca aparece em página pública.
6. Teste unitário e E2E cobrindo 1 a 5.
