# Deploy do Mix0Grau na Vercel

Este projeto agora usa uma API serverless em `api/index.js`. Na Vercel, nao use SQLite/local file como banco principal, porque o filesystem das funcoes nao e persistente. Use Postgres, por exemplo Neon.

## Variaveis de ambiente

Configure na Vercel:

- `DATABASE_URL`: string de conexao Postgres/Neon.
- `MIX0GRAU_ADMIN_PIN`: PIN do painel administrativo.
- `STORE_WHATSAPP`: numero internacional da loja. Padrao: `559899044137`.

## Rotas principais

- Cliente: `/api/products`, `/api/login`, `/api/me`, `/api/orders`.
- Admin: `/api/admin/orders`, `/api/admin/order_status`, `/api/admin/redeem`.
- Gestao: `/api/admin/erp/dashboard`, `/api/admin/erp/products`, `/api/admin/erp/product`, `/api/admin/erp/stock`, `/api/admin/erp/clients`, `/api/admin/erp/client`, `/api/admin/erp/expenses`, `/api/admin/erp/expense`, `/api/admin/erp/expense_edit`, `/api/admin/erp/expense_delete`, `/api/admin/erp/movements`.

## Cadastro e seguranca

O cliente novo pode se cadastrar com nome, WhatsApp e endereco. Depois disso, o navegador guarda um token; pedidos e dados do perfil usam esse token. Se um telefone ja existir, a API nao libera o perfil apenas digitando o numero em outro navegador. Para recuperacao automatica em producao, o proximo passo correto e integrar um provedor de OTP/SMS/WhatsApp.

## Teste rapido antes do deploy

```bash
npm install
npm run check
```

Depois de publicar, acesse:

- Cardapio: `https://seu-dominio/`
- Admin: `https://seu-dominio/admin.html`
