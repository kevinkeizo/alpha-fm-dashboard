// Diagnostica um token da Meta antes de colocar ele em produção.
//
//   node scripts/verifica-token.mjs SEU_TOKEN
//   node scripts/verifica-token.mjs            (usa a env IG_TOKEN)
//
// Responde as três perguntas que importam:
//   1. ele expira? quando?
//   2. é token de página (o que não vence) ou de usuário (60 dias)?
//   3. tem as permissões que o dashboard precisa?

const token = process.argv[2] || process.env.IG_TOKEN;

if (!token) {
  console.error('Uso: node scripts/verifica-token.mjs SEU_TOKEN');
  process.exit(1);
}

const PERMISSOES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
];

const api = async (caminho) => {
  const r = await fetch(`https://graph.facebook.com/v22.0/${caminho}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
};

const data = (seg) => new Date(seg * 1000).toISOString().split('T')[0];

try {
  const { data: d } = await api(
    `debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
  );

  console.log('\n── Token ─────────────────────────────────────');
  console.log('  tipo      :', d.type || '(não informado)');
  console.log('  app       :', d.application || '(não informado)');
  console.log('  válido    :', d.is_valid ? 'sim' : 'NÃO');

  // expires_at = 0 significa que não expira. É o que queremos.
  if (d.expires_at === 0) {
    console.log('  expira    : NUNCA  <<< é esse que você quer');
  } else if (d.expires_at) {
    const dias = Math.ceil((d.expires_at * 1000 - Date.now()) / 86400000);
    console.log(`  expira    : ${data(d.expires_at)}  (${dias} dias)`);
    console.log('              ainda é token de usuário, não de página');
  } else {
    console.log('  expira    : não informado');
  }

  if (d.data_access_expires_at) {
    const dias = Math.ceil((d.data_access_expires_at * 1000 - Date.now()) / 86400000);
    console.log(`  acesso a dados até: ${data(d.data_access_expires_at)} (${dias} dias)`);
  }

  console.log('\n── Permissões ────────────────────────────────');
  const tem = new Set(d.scopes || []);
  let faltando = 0;
  for (const p of PERMISSOES) {
    const ok = tem.has(p);
    if (!ok) faltando++;
    console.log(`  ${ok ? 'ok  ' : 'FALTA'}  ${p}`);
  }

  console.log('\n── Conta do Instagram ────────────────────────');
  try {
    const contas = await api(
      `me/accounts?fields=name,instagram_business_account&access_token=${encodeURIComponent(token)}`
    );
    for (const p of contas.data || []) {
      const ig = p.instagram_business_account;
      console.log(`  página: ${p.name}`);
      console.log(`  IG_USER_ID: ${ig ? ig.id : '(nenhum Instagram ligado)'}`);
    }
    if (!(contas.data || []).length) console.log('  nenhuma página retornada');
  } catch (e) {
    // Um page token não responde me/accounts, e isso é esperado.
    console.log('  (não listou páginas: normal para token de página)');
  }

  console.log('\n── Veredito ──────────────────────────────────');
  if (!d.is_valid) {
    console.log('  Token inválido. Gere outro.');
  } else if (faltando) {
    console.log(`  Faltam ${faltando} permissões. O dashboard vai falhar em parte dos dados.`);
  } else if (d.expires_at === 0) {
    console.log('  Pronto para produção, e não expira. Pode colar no Vercel e no GitHub.');
  } else {
    console.log('  Funciona, mas ainda vence. Faça o passo do me/accounts para');
    console.log('  pegar o token da página, que é o que não expira.');
  }
  console.log('');
} catch (e) {
  console.error('\nErro ao consultar a Meta:', e.message, '\n');
  process.exit(1);
}
