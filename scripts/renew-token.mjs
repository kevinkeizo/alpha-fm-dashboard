const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CURRENT_TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !CURRENT_TOKEN || !IG_USER_ID) {
  console.error('Faltam variáveis de ambiente: CLIENT_ID, CLIENT_SECRET, IG_TOKEN, IG_USER_ID');
  process.exit(1);
}

async function renewToken() {
  try {
    console.log('🔄 Iniciando renovação de token...');

    // Step 1: Troca token curto por token longo (se necessário)
    // Esse endpoint renova um token já longo
    const renewUrl = new URL('https://graph.instagram.com/refresh_access_token');
    renewUrl.searchParams.set('grant_type', 'ig_refresh_token');
    renewUrl.searchParams.set('access_token', CURRENT_TOKEN);

    const renewRes = await fetch(renewUrl.toString());
    const renewData = await renewRes.json();

    if (renewData.error) {
      throw new Error(`Erro ao renovar token: ${renewData.error.message}`);
    }

    const newToken = renewData.access_token;
    console.log('✅ Token renovado com sucesso!');
    console.log(`📅 Expira em: ${renewData.expires_in} segundos (~${Math.round(renewData.expires_in / 86400)} dias)`);

    // Step 2: Valida o novo token fazendo uma chamada simples
    console.log('\n🔍 Validando novo token...');
    const validateRes = await fetch(`https://graph.instagram.com/me?access_token=${newToken}`);
    const validateData = await validateRes.json();

    if (validateData.error) {
      throw new Error(`Erro ao validar token: ${validateData.error.message}`);
    }

    console.log(`✅ Token validado! IG User ID: ${validateData.id}`);

    // Step 3: Output pra GitHub Actions usar pra atualizar Secret
    console.log('\n📤 Token pronto pra atualizar nos Secrets');
    console.log(`NEW_TOKEN=${newToken}`);

    return { success: true, token: newToken };
  } catch (error) {
    console.error('❌ Falha na renovação:', error.message);
    process.exit(1);
  }
}

renewToken();
