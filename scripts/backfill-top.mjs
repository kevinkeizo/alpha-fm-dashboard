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

const espera = ms => new Promise(r => setTimeout(r, ms));

// 30 dias são ~1.200 publicações. Nesse volume a Meta devolve erro transitório
// com frequência ("An unexpected error has occurred"), que some ao repetir.
// Sem retry o job inteiro morria na primeira falha.
function ehTransitorio(msg){
  return /unexpected error|rate limit|reduce the amount|temporarily|try again|timeout/i.test(msg || '');
}

async function fetchGraph(path, params, tentativa){
  const t = tentativa || 0;
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);

  let json;
  try{
    const res = await fetch(url.toString());
    json = JSON.parse(await res.text());
  }catch(e){
    if(t < 4){ await espera(1500 * Math.pow(2, t)); return fetchGraph(path, params, t + 1); }
    throw new Error('rede: ' + e.message);
  }

  if(json.error){
    if(ehTransitorio(json.error.message) && t < 4){
      await espera(1500 * Math.pow(2, t));
      return fetchGraph(path, params, t + 1);
    }
    throw new Error(json.error.message);
  }
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
  let truncou = false;
  for(let p = 0; p < 40; p++){
    let r;
    try{
      r = await fetchGraph('/' + IG_USER_ID + '/media', params);
    }catch(e){
      // Melhor gravar os dias que já vieram do que perder o job inteiro
      console.warn('Paginação parou na página ' + p + ':', e.message);
      truncou = true;
      break;
    }
    const data = r.data || [];
    todas.push(...data);
    const ultimo = data[data.length - 1];
    if(!ultimo) break;
    if(Math.floor(new Date(ultimo.timestamp).getTime() / 1000) < limite) break;
    const after = r.paging && r.paging.cursors && r.paging.cursors.after;
    if(!after) break;
    params = { ...params, after };
    await espera(300); // respiro entre páginas
  }
  console.log('Publicações lidas:', todas.length, truncou ? '(paginação truncada)' : '');

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
    const comMetricas = (await mapLimit(porDia[dia], 4, m => metricasDaMidia(m, fetchGraph)))
      .filter(Boolean);
    comMetricas.sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1));
    const topDoDia = comMetricas.slice(0, TOP_POR_DIA);

    const corte = new Date(new Date(hoje + 'T12:00:00Z').getTime() - JANELA_TOP * 86400000)
      .toISOString().slice(0, 10);
    top = mesclaTop(top, topDoDia, corte);

    const melhor = topDoDia[0];
    // Grava a cada dia: se a API cair no meio, o que já veio fica salvo
    await fs.writeFile(topPath, JSON.stringify(top, null, 2) + '\n');
    console.log('  ' + dia + ':', porDia[dia].length, 'publicações ->', topDoDia.length,
      'no ranking | melhor:', melhor ? melhor.interactions + ' interações' : '—');
  }

  await fs.writeFile(topPath, JSON.stringify(top, null, 2) + '\n');
  console.log('Pronto:', top.recentes.length, 'no período |', top.allTime.length, 'no all-time');
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
