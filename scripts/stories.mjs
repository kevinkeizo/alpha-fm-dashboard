// Captura de stories.
//
// A Meta só expõe os stories ATIVOS (24h). Uma leitura por dia não basta:
// um story publicado às 20h de segunda expira às 20h de terça, então a
// captura da madrugada de terça o pega com 5h de vida — números pela metade —
// e a da tarde já não o encontra mais.
//
// Por isso este job roda de 3 em 3 horas e MESCLA: para cada story guarda o
// maior valor já visto de cada métrica. Assim um story é acompanhado ao longo
// da vida inteira e o total do dia fecha certo.

const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';

// Detalhe por story só é útil enquanto ele pode receber mais números.
// Passado isso, o que fica é o agregado diário, que é pequeno e permanente.
const RETENCAO_DETALHE_DIAS = 12;

if(!TOKEN || !IG_USER_ID){
  console.error('Faltam IG_TOKEN e/ou IG_USER_ID.');
  process.exit(1);
}

const espera = ms => new Promise(r => setTimeout(r, ms));

function brtDateStr(d){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function brtHora(d){
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit'
  }).format(d);
}

function transitorio(msg){
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
    if(t < 3){ await espera(1500 * Math.pow(2, t)); return fetchGraph(path, params, t + 1); }
    throw new Error('rede: ' + e.message);
  }
  if(json.error){
    if(transitorio(json.error.message) && t < 3){
      await espera(1500 * Math.pow(2, t));
      return fetchGraph(path, params, t + 1);
    }
    throw new Error(json.error.message);
  }
  return json;
}

async function metricasDoStory(id){
  const base = ['views', 'reach', 'replies', 'navigation', 'total_interactions', 'shares'];
  const vals = {};
  const absorve = j => (j.data || []).forEach(d => {
    const v = d.values && d.values[0] ? d.values[0].value : null;
    if(typeof v === 'number') vals[d.name] = v;
  });
  try{
    absorve(await fetchGraph('/' + id + '/insights', { metric: base.join(',') }));
  }catch(e){
    for(const m of base){
      try{ absorve(await fetchGraph('/' + id + '/insights', { metric: m })); }catch(e2){}
    }
  }
  return vals;
}

async function mapLimit(items, limite, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
    for(;;){
      const idx = i++;
      if(idx >= items.length) return;
      try{ out[idx] = await fn(items[idx]); }catch(e){ out[idx] = null; }
    }
  }));
  return out;
}

// Métrica de story só cresce. Um valor menor numa leitura posterior é ruído
// da Meta, não queda real — então fica o maior já visto.
function maior(a, b){
  if(typeof a !== 'number') return typeof b === 'number' ? b : null;
  if(typeof b !== 'number') return a;
  return Math.max(a, b);
}

function agregaDia(lista){
  const alcances = lista.map(s => s.reach).filter(v => typeof v === 'number');
  const soma = c => lista.reduce((a, s) => a + (s[c] || 0), 0);
  return {
    qtd: lista.length,
    views: soma('views'),
    // Alcance de stories não soma entre stories: a mesma pessoa vê vários.
    // O maior de um story isolado é a melhor leitura de "quantos vimos".
    alcanceMaximo: alcances.length ? Math.max(...alcances) : null,
    alcanceMedio: alcances.length ? Math.round(alcances.reduce((a, b) => a + b, 0) / alcances.length) : null,
    replies: soma('replies'),
    interactions: soma('interactions'),
    navigation: soma('navigation')
  };
}

async function main(){
  const lista = await fetchGraph('/' + IG_USER_ID + '/stories', {
    fields: 'id,media_type,permalink,timestamp'
  });
  const ativos = lista.data || [];
  console.log('Stories no ar:', ativos.length);

  const lidos = (await mapLimit(ativos, 5, async m => {
    const v = await metricasDoStory(m.id);
    const d = new Date(m.timestamp);
    return {
      id: m.id,
      date: brtDateStr(d),
      hora: brtHora(d),
      timestamp: m.timestamp,
      permalink: m.permalink || null,
      media_type: m.media_type || null,
      views: v.views ?? null,
      reach: v.reach ?? null,
      replies: v.replies ?? null,
      navigation: v.navigation ?? null,
      interactions: v.total_interactions ?? null,
      shares: v.shares ?? null
    };
  })).filter(Boolean);

  const fs = await import('node:fs/promises');
  const detPath = new URL('../stories-recentes.json', import.meta.url);
  const diaPath = new URL('../stories-diario.json', import.meta.url);

  // ── Mescla no detalhe, guardando o maior valor já visto ──
  let detalhe = {};
  try{ detalhe = JSON.parse(await fs.readFile(detPath, 'utf8')) || {}; }catch(e){}

  let novos = 0, atualizados = 0;
  lidos.forEach(s => {
    const antes = detalhe[s.id];
    if(!antes){ detalhe[s.id] = s; novos++; return; }
    ['views','reach','replies','navigation','interactions','shares'].forEach(c => {
      antes[c] = maior(antes[c], s[c]);
    });
    atualizados++;
  });

  // Poda o detalhe; o agregado diário fica para sempre
  const corte = brtDateStr(new Date(Date.now() - RETENCAO_DETALHE_DIAS * 86400000));
  Object.keys(detalhe).forEach(id => {
    if(!detalhe[id] || !detalhe[id].date || detalhe[id].date < corte) delete detalhe[id];
  });

  await fs.writeFile(detPath, JSON.stringify(detalhe, null, 2) + String.fromCharCode(10));

  // ── Recalcula o agregado dos dias que ainda têm detalhe ──
  let diario = {};
  try{ diario = JSON.parse(await fs.readFile(diaPath, 'utf8')) || {}; }catch(e){}

  const porDia = {};
  Object.values(detalhe).forEach(s => { (porDia[s.date] = porDia[s.date] || []).push(s); });

  Object.entries(porDia).forEach(([dia, l]) => {
    diario[dia] = Object.assign({ date: dia }, agregaDia(l), { atualizado: new Date().toISOString() });
  });

  // Ordena por data pra o arquivo ficar legível
  const ordenado = {};
  Object.keys(diario).sort().forEach(k => { ordenado[k] = diario[k]; });
  await fs.writeFile(diaPath, JSON.stringify(ordenado, null, 2) + String.fromCharCode(10));

  const hoje = brtDateStr(new Date());
  const d = ordenado[hoje];
  console.log('Detalhe: ' + novos + ' novos, ' + atualizados + ' atualizados, ' +
    Object.keys(detalhe).length + ' guardados.');
  console.log('Dias com agregado: ' + Object.keys(ordenado).length +
    (d ? ' | hoje: ' + d.qtd + ' stories, ' + d.views.toLocaleString('pt-BR') + ' views' : ''));
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
