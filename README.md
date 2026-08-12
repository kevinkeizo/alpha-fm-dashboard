# Alpha FM · Dashboard de Instagram

Dashboard em tempo real (seguidores, alcance, publicações, engajamento) conectado direto na Instagram Graph API. Um único arquivo estático (`index.html`), sem backend.

## Como rodar

1. Abre o `index.html` num navegador (local ou via GitHub Pages, ver abaixo).
2. Na primeira vez, cola o **access token** e o **Instagram User ID** da conta profissional.
3. Fica salvo no `localStorage` daquele navegador. Não precisa colar de novo depois.

## Como publicar no GitHub Pages (deixa acessível por URL)

1. Sobe esse repositório pro GitHub (via VS Code: `Source Control` → `Publish to GitHub`, ou linha de comando).
2. No repositório, vai em **Settings → Pages**.
3. Em **Source**, escolhe a branch `main` e a pasta `/ (root)`.
4. Salva. Em alguns minutos o dashboard fica disponível em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.
5. No computador do telão, é só abrir essa URL no navegador (em vez de guardar o arquivo local).

## Gerando o access token (resumo)

1. Cria um app em [developers.facebook.com](https://developers.facebook.com) → **Meus apps → Criar app → Negócios**.
2. Adiciona o caso de uso **"Gerenciar mensagens e conteúdo no Instagram"**, depois troca pra **"API setup with Facebook login"** dentro dele (é o fluxo certo pra insights).
3. No **Explorador da Graph API**, seleciona o app, marca as permissões `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, e gera o token.
4. Troca esse token por um de longa duração (~60 dias) usando:
   ```
   oauth/access_token?grant_type=fb_exchange_token&client_id=SEU_APP_ID&client_secret=SEU_APP_SECRET&fb_exchange_token=TOKEN_CURTO
   ```
5. Pega o Instagram User ID com:
   ```
   me/accounts?fields=name,instagram_business_account
   ```

## Limitações atuais (importante pro time de dev)

- **Token fica no navegador**: qualquer pessoa com acesso ao DevTools daquele navegador consegue ver o token. Funciona bem pra uso interno, mas não é o ideal pra algo 100% público.
- **Histórico é local por navegador**: o gráfico de evolução de seguidores usa `localStorage`, então só existe naquele navegador/computador específico. Trocar de máquina ou limpar dados de navegação reseta o histórico.
- **Sem automação real**: os dados só atualizam enquanto a aba está aberta (o Modo TV atualiza sozinho a cada 5 min, inclusive na virada do dia). Se quiser que funcione mesmo com tudo desligado, precisa de:
  - Um backend simples que guarda o token em variável de ambiente e faz as chamadas à API.
  - Um job agendado (ex: GitHub Actions com cron, ou qualquer scheduler) que roda 1x por dia e grava o snapshot num banco de verdade (Postgres, Supabase, Firebase etc).
  - O front-end passa a ler desse banco/endpoint em vez de chamar a Meta diretamente.

## Modo TV

Botão de monitor no cabeçalho: entra em tela cheia, aumenta as fontes, esconde os controles desnecessários e liga a atualização automática a cada 5 minutos.
