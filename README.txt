MIX0GRAU - CARDAPIO, FIDELIDADE E GESTAO

Projeto preparado para deploy na Vercel com API serverless em Node.js.

Variaveis obrigatorias na Vercel:
- DATABASE_URL: conexao Postgres/Neon.
- MIX0GRAU_ADMIN_PIN: PIN para abrir o painel admin.
- STORE_WHATSAPP: numero internacional da loja. Padrao: 559899044137.

Comandos:
1. npm install
2. npm run check

Paginas:
- Cardapio: /
- Painel admin: /admin.html

O cadastro salva nome, WhatsApp e endereco no banco persistente. Se um telefone ja existir, a API exige o token salvo no navegador, para evitar que outra pessoa acesse o perfil apenas digitando o mesmo numero.

Para detalhes do deploy, veja VERCEL.md.
