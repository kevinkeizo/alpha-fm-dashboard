// Reparo único do histórico.
//
// Todas as execuções agendadas rodaram entre 03:28 e 03:40 UTC, ou seja
// 00:28-00:40 em Brasília — sempre DEPOIS da meia-noite, nunca às 23:50 como
// o cron pretendia. Duas consequências:
//
//   1. followers gravado sob o dia D é o fechamento do dia D-1.
//   2. posts/reels contavam publicações do dia D num momento em que o dia D
//      tinha ~40 minutos de idade, daí os zeros.
//
// alcance/views/interações já foram corrigidos pelo backfill do snapshot,
// que refaz cada dia com janela explícita. Aqui trata-se só do resto.
//
// Rodar uma vez via workflow_dispatch. Depois disso pode ser apagado.

const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

if(!TOKEN || !IG_USER_ID){
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID.');
  process.exit(1);
}

// Valores de seguidores como estavam antes dos disparos manuais de hoje
// (commit a63b34e). A chave é a data sob a qual o valor FOI gravado; o valor
// pertence ao fechamento do dia anterior.
const GRAVADO = {
  '2026-08-12': 963404, '2026-08-13': 963929, '2026-08-14': 964893,
  '2026-08-15': 965494, '2026-08-16': 966184, '2026-08-17': 966706,
  '2026-08-18': 967369, '2026-08-19': 967809, '2026-08-20': 968203,
  '2026-08-21': 968816, '2026-08-22': 969399, '2026-08-23': 970058,
  '2026-08-24': 970925
};

function diaAnterior(dateStr){
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function brazilDateKey(d){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

async function fetchGraph(path, params){
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  const json = JSON.parse(await res.text());
  if(json.error) throw new Error(json.error.message);
  return json;
}

async function main(){
  const fs = await import('node:fs/promises');
  const path = new URL('../history.json', import.meta.url);
  const history = JSON.parse(await fs.readFile(path, 'utf8'));

  // 1. Desloca followers: o valor gravado em D pertence a D-1.
  const corrigido = new Map();
  for(const [gravadoEm, valor] of Object.entries(GRAVADO)){
    corrigido.set(diaAnterior(gravadoEm), valor);
  }

  // 2. Recontagem de publicações por dia, paginando de verdade.
  const maisAntigo = [...corrigido.keys()].sort()[0];
  const limite = Math.floor(new Date(maisAntigo + 'T00:00:00-03:00').getTime() / 1000);
  const midia = [];
  let params = { fields: 'id,timestamp,media_type,media_product_type', limit: '100' };
  for(let p = 0; p < 30; p++){
    const r = await fetchGraph('/' + IG_USER_ID + '/media', params);
    const data = r.data || [];
    midia.push(...data);
    const ultimo = data[data.length - 1];
    if(!ultimo) break;
    if(Math.floor(new Date(ultimo.timestamp).getTime() / 1000) < limite) break;
    const after = r.paging && r.paging.cursors && r.paging.cursors.after;
    if(!after) break;
    params = { ...params, after };
  }
  console.log('Publicações lidas:', midia.length);

  const porDia = {};
  midia.forEach(m => {
    const k = brazilDateKey(new Date(m.timestamp));
    porDia[k] = porDia[k] || { posts: 0, reels: 0 };
    porDia[k].posts++;
    if(m.media_product_type === 'REELS' || m.media_type === 'VIDEO') porDia[k].reels++;
  });

  // 3. Aplica. O dia mais recente sai fora: só fecha na próxima execução.
  const maisRecente = [...corrigido.keys()].sort().pop();
  const saida = [];
  const datas = new Set([...corrigido.keys(), ...history.map(h => h.date)]);

  for(const date of [...datas].sort()){
    if(date > maisRecente) continue;
    const antes = history.find(h => h.date === date) || { date };
    const followers = corrigido.get(date) ?? antes.followers ?? null;
    const contagem = porDia[date];
    const e = {
      date,
      followers,
      reach: antes.reach ?? null,
      views: antes.views ?? null,
      reelViews: antes.reelViews ?? null,
      reels: contagem ? contagem.reels : (antes.reels ?? null),
      posts: contagem ? contagem.posts : (antes.posts ?? null),
      interactions: antes.interactions ?? null,
      engagementRate: null
    };
    e.engagementRate = (e.interactions != null && e.reach) ? (e.interactions / e.reach * 100) : null;
    saida.push(e);

    const antesPosts = antes.posts ?? '-';
    const antesFoll = antes.followers ?? '-';
    if(antesFoll !== followers || antesPosts !== e.posts){
      console.log(`  ${date}: seguidores ${antesFoll} -> ${followers} | posts ${antesPosts} -> ${e.posts}`);
    }
  }

  await fs.writeFile(path, JSON.stringify(saida, null, 2) + '\n');
  console.log('Histórico reparado:', saida.length, 'dias.');
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
