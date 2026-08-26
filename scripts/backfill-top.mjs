// Preenche o ranking de publicações retroativamente.
// Uso: node scripts/backfill-top.mjs [dias]   (padrão 7)
//
// Roda uma vez pra popular a seção enquanto o snapshot noturno ainda não
// acumulou histórico. Depois disso o snapshot mantém sozinho.

import { mapLimit, metricasDaMidia, mesclaTop } from './snapshot.mjs';

const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';
const TOP_POR_DIA = 10;
const JANELA_TOP = 35;

const DIAS = Math.min(Math.max(parseInt(process.argv[2], 10) || 7, 1), 30);

if(!TOKEN || !IG_USER_ID){
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID.');
  process.exit(1);
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
  const hoje = brazilDateKey(new Date());
  const limite = Math.floor(new Date(
    new Date(hoje + 'T00:00:00-03:00').getTime() - DIAS * 86400000
  ).getTime() / 1000);

  // Puxa toda a mídia da janela de uma vez, paginando
  const todas = [];
  let params = {
    fields: 'id,timestamp,media_type,media_product_type,media_url,thumbnail_url,permalink,caption',
    limit: '100'
  };
  for(let p = 0; p < 30; p++){
    const r = await fetchGraph('/' + IG_USER_ID + '/media', params);
    const data = r.data || [];
    todas.push(...data);
    const ultimo = data[data.length - 1];
    if(!ultimo) break;
    if(Math.floor(new Date(ultimo.timestamp).getTime() / 1000) < limite) break;
    const after = r.paging && r.paging.cursors && r.paging.cursors.after;
    if(!after) break;
    params = { ...params, after };
  }
  console.log('Publicações lidas:', todas.length);

  // Agrupa por dia, ignorando hoje (que o /api/top resolve ao vivo)
  const porDia = {};
  todas.forEach(m => {
    const k = brazilDateKey(new Date(m.timestamp));
    if(k >= hoje) return;
    if(Math.floor(new Date(m.timestamp).getTime() / 1000) < limite) return;
    (porDia[k] = porDia[k] || []).push(m);
  });

  const dias = Object.keys(porDia).sort();
  console.log('Dias a processar:', dias.length, '->', dias.join(', '));

  const fs = await import('node:fs/promises');
  const topPath = new URL('../top-posts.json', import.meta.url);
  let top = { recentes: [], allTime: [] };
  try{ top = JSON.parse(await fs.readFile(topPath, 'utf8')); }catch(e){}

  for(const dia of dias){
    const comMetricas = (await mapLimit(porDia[dia], 6, m => metricasDaMidia(m, fetchGraph)))
      .filter(Boolean);
    comMetricas.sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1));
    const topDoDia = comMetricas.slice(0, TOP_POR_DIA);

    const corte = new Date(new Date(hoje + 'T12:00:00Z').getTime() - JANELA_TOP * 86400000)
      .toISOString().slice(0, 10);
    top = mesclaTop(top, topDoDia, corte);

    const melhor = topDoDia[0];
    console.log('  ' + dia + ':', porDia[dia].length, 'publicações ->', topDoDia.length,
      'no ranking | melhor:', melhor ? melhor.interactions + ' interações' : '—');
  }

  await fs.writeFile(topPath, JSON.stringify(top, null, 2) + '\n');
  console.log('Pronto:', top.recentes.length, 'no período |', top.allTime.length, 'no all-time');
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
