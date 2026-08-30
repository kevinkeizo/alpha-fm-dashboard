// Âncora de seguidores.
//
// O agendador do GitHub atrasa de 7 a 13h com frequência, então a captura
// noturna quase nunca cai perto da meia-noite — e o fechamento do dia virava
// estimativa. Este job faz UMA chamada à Meta e guarda a contagem com a hora.
// Rodando de 3 em 3 horas, sempre existe uma medição perto da virada, e o
// snapshot passa a ter valor medido em vez de interpolado.
//
// De propósito é minúsculo: quanto menos ele faz, menos tem para falhar.

const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';

// Quantos dias de âncora manter. O snapshot só precisa das últimas para
// interpolar; guardar mais só engorda o arquivo que o navegador não lê.
const RETENCAO_DIAS = 10;

if(!TOKEN || !IG_USER_ID){
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID.');
  process.exit(1);
}

const espera = ms => new Promise(r => setTimeout(r, ms));

async function lerSeguidores(tentativa = 0){
  const url = new URL('https://graph.facebook.com/' + API_VERSION + '/' + IG_USER_ID);
  url.searchParams.set('fields', 'followers_count');
  url.searchParams.set('access_token', TOKEN);

  try{
    const res = await fetch(url.toString());
    const json = JSON.parse(await res.text());
    if(json.error) throw new Error(json.error.message);
    if(typeof json.followers_count !== 'number') throw new Error('followers_count ausente');
    return json.followers_count;
  }catch(e){
    // Erro transitório da Meta é comum; uma âncora perdida abre buraco
    if(tentativa < 3){
      await espera(2000 * Math.pow(2, tentativa));
      return lerSeguidores(tentativa + 1);
    }
    throw e;
  }
}

async function main(){
  const valor = await lerSeguidores();
  const agora = new Date().toISOString();

  const fs = await import('node:fs/promises');
  const caminho = new URL('../anchors.json', import.meta.url);

  let ancoras = [];
  try{ ancoras = JSON.parse(await fs.readFile(caminho, 'utf8')); }catch(e){ ancoras = []; }
  if(!Array.isArray(ancoras)) ancoras = [];

  ancoras.push({ t: agora, v: valor });

  // Ordena e descarta o que já não serve
  const corte = Date.now() - RETENCAO_DIAS * 86400000;
  ancoras = ancoras
    .filter(a => a && typeof a.v === 'number' && Date.parse(a.t) >= corte)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

  await fs.writeFile(caminho, JSON.stringify(ancoras, null, 2) + '\n');

  const brt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(agora));

  console.log('Âncora ' + brt + ' BRT: ' + valor.toLocaleString('pt-BR') +
    ' (' + ancoras.length + ' guardadas)');
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
