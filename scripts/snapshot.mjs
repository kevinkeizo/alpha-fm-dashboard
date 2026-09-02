const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';
const HISTORY_LIMIT = 800;
// Quantos dias recentes reconferir a cada execução. A Meta guarda insights
// por ~2 anos, mas 30 dias cobre o estrago sem estourar o limite de chamadas.
const BACKFILL_DAYS = 30;
// Ranking de publicações: quantas por dia guardar e por quantos dias.
// 10 x 35 dias ~ 350 registros, arquivo leve o bastante pro navegador.
const TOP_POR_DIA = 10;
const JANELA_TOP = 35;

if(!TOKEN || !IG_USER_ID){
  console.error('Faltam as variáveis de ambiente IG_TOKEN e/ou IG_USER_ID.');
  process.exit(1);
}

function brazilDateKey(d){
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Brasil não observa horário de verão desde 2019, então o offset -03:00 é fixo.
function brazilDayStart(d){
  return new Date(brazilDateKey(d) + 'T00:00:00-03:00');
}

async function fetchGraph(path, params){
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  const text = await res.text();
  let json;
  try{ json = text ? JSON.parse(text) : {}; }
  catch(e){ throw new Error('Resposta inválida da Meta (status ' + res.status + ').'); }
  if(json.error) throw new Error(json.error.message || 'Erro desconhecido na API do Meta');
  if(!res.ok) throw new Error('HTTP ' + res.status + ' ao consultar a API da Meta.');
  return json;
}

// Roda `fn` com no máximo `limit` chamadas simultâneas.
export async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for(;;){
      const idx = i++;
      if(idx >= items.length) return;
      try{ out[idx] = await fn(items[idx]); }
      catch(e){ out[idx] = null; }
    }
  }));
  return out;
}

// Métricas de uma publicação. Pede tudo numa chamada e só cai pra uma a uma
// se a Meta recusar o combo. 'follows' vai à parte porque reels não aceitam.
export async function metricasDaMidia(m, fetch_ = fetchGraph){
  const isVideo = m.media_product_type === 'REELS' || m.media_type === 'VIDEO';
  const base = ['reach', 'views', 'total_interactions', 'likes', 'comments', 'saved', 'shares'];
  const vals = {};
  const absorve = json => (json.data || []).forEach(d => {
    const v = d.values && d.values[0] ? d.values[0].value : null;
    if(typeof v === 'number') vals[d.name] = v;
  });

  try{
    absorve(await fetch_('/' + m.id + '/insights', { metric: base.join(',') }));
  }catch(e){
    for(const metric of base){
      try{ absorve(await fetch_('/' + m.id + '/insights', { metric })); }catch(e2){}
    }
  }

  let follows = null;
  if(!isVideo){
    try{
      const r = await fetch_('/' + m.id + '/insights', { metric: 'follows' });
      const row = (r.data || []).find(d => d.name === 'follows');
      const v = row && row.values && row.values[0] ? row.values[0].value : null;
      if(typeof v === 'number') follows = v;
    }catch(e){}
  }

  return {
    id: m.id,
    permalink: m.permalink,
    media_url: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
    media_type: m.media_type,
    isReel: m.media_product_type === 'REELS',
    isVideo,
    caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 90),
    timestamp: m.timestamp,
    date: brazilDateKey(new Date(m.timestamp)),
    hora: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
      .format(new Date(m.timestamp)),
    reach: vals.reach ?? null,
    views: vals.views ?? null,
    interactions: vals.total_interactions ?? null,
    likes: vals.likes ?? null,
    comments: vals.comments ?? null,
    saved: vals.saved ?? null,
    shares: vals.shares ?? null,
    follows
  };
}

// Junta o ranking de um dia ao arquivo, mantendo `recentes` curto e a
// lista de sempre no topo. Sem isso o arquivo cresceria sem limite e o
// navegador teria que baixar tudo a cada carregamento.
export function mesclaTop(atual, novos, diaLimite){
  const recentes = (atual.recentes || []).filter(p =>
    !novos.some(n => n.date === p.date) && p.date >= diaLimite
  );
  recentes.push(...novos);
  recentes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const porId = new Map();
  [...(atual.allTime || []), ...novos].forEach(p => {
    const anterior = porId.get(p.id);
    // Um post reaparece com números maiores; fica a leitura mais recente.
    if(!anterior || (p.interactions ?? 0) >= (anterior.interactions ?? 0)) porId.set(p.id, p);
  });
  const allTime = [...porId.values()]
    .sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1))
    .slice(0, 30);

  return { atualizado: new Date().toISOString(), recentes, allTime };
}

// Busca uma métrica total_value numa janela explícita.
// Cada métrica vai numa chamada separada de propósito: pedir duas juntas
// faz a Meta rejeitar a requisição inteira e perder as duas.
async function totalValue(metric, since, until){
  try{
    const r = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric, metric_type: 'total_value', period: 'day',
      since: String(since), until: String(until)
    });
    const row = (r.data || []).find(m => m.name === metric);
    const v = row && row.total_value ? row.total_value.value : null;
    return typeof v === 'number' ? v : null;
  }catch(e){
    console.warn(metric + ' falhou:', e.message);
    return null;
  }
}

// A conta publica ~40 vezes por dia, então uma página de 50 não cobre nem um
// dia inteiro. Pagina até passar do início do dia alvo.
async function fetchMediaDoDia(dayStartSec){
  const todas = [];
  let params = {
    fields: 'id,timestamp,media_type,media_product_type,media_url,thumbnail_url,permalink,caption',
    limit: '100'
  };
  for(let pagina = 0; pagina < 10; pagina++){
    const r = await fetchGraph('/' + IG_USER_ID + '/media', params);
    const data = r.data || [];
    todas.push(...data);
    const maisAntigo = data[data.length - 1];
    if(!maisAntigo) break;
    // Já ultrapassou o dia alvo, não precisa de mais páginas
    if(Math.floor(new Date(maisAntigo.timestamp).getTime() / 1000) < dayStartSec) break;
    const after = r.paging && r.paging.cursors && r.paging.cursors.after;
    if(!after) break;
    params = { ...params, after };
  }
  return todas;
}



// Uma âncora a menos de 90 min da virada vale como medição: em ~700
// seguidores/dia isso é uma margem de ~45, abaixo do ruído do próprio número.
// Passou disso, é interpolação — e aí fica marcado como estimativa.
const TOLERANCIA_ANCORA_MIN = 90;

async function lerAncoras(){
  try{
    const fs2 = await import('node:fs/promises');
    const cru = await fs2.readFile(new URL('../anchors.json', import.meta.url), 'utf8');
    const a = JSON.parse(cru);
    return Array.isArray(a) ? a.filter(x => x && typeof x.v === 'number' && x.t) : [];
  }catch(e){ return []; }
}

// Âncora mais próxima de `alvoMs`, se estiver dentro da tolerância
function ancoraNaVirada(ancoras, alvoMs){
  let melhor = null, menorDist = Infinity;
  ancoras.forEach(a => {
    const d = Math.abs(Date.parse(a.t) - alvoMs);
    if(d < menorDist){ menorDist = d; melhor = a; }
  });
  if(!melhor || menorDist > TOLERANCIA_ANCORA_MIN * 60000) return null;
  return { valor: melhor.v, distMin: Math.round(menorDist / 60000) };
}

// Um dia sem followers abre buraco na série: o painel perde o ganho diário e
// o gráfico corta. Como seguidor só anda pra frente e devagar, interpolar
// entre duas medições reais dá um número muito melhor que deixar vazio —
// desde que fique marcado como estimativa, nunca passando por medido.
function fimDoDiaMs(dateKey){
  return new Date(dateKey + 'T00:00:00-03:00').getTime() + 86400000;
}

function preencherLacunas(history, extras){
  // Âncoras: (instante, valor) de tudo que foi realmente medido
  const ancoras = (extras || []).map(a => ({ t: Date.parse(a.t), v: a.v }));
  history.forEach(h => {
    if(h.followers != null && !h.followersEstimado){
      ancoras.push({ t: fimDoDiaMs(h.date), v: h.followers });
    }
    if(h.followersRef && h.followersRef.valor != null){
      ancoras.push({ t: Date.parse(h.followersRef.quando), v: h.followersRef.valor });
    }
  });
  ancoras.sort((a, b) => a.t - b.t);
  if(ancoras.length < 2) return 0;

  let preenchidos = 0;
  history.forEach(h => {
    if(h.followers != null) return;
    const alvo = fimDoDiaMs(h.date);
    const antes = [...ancoras].reverse().find(a => a.t <= alvo);
    const depois = ancoras.find(a => a.t >= alvo);
    if(!antes || !depois || antes.t === depois.t) return;

    const p = (alvo - antes.t) / (depois.t - antes.t);
    h.followers = Math.round(antes.v + (depois.v - antes.v) * p);
    h.followersEstimado = true;
    preenchidos++;
    console.log('  ' + h.date + ': seguidores estimados em ' + h.followers.toLocaleString('pt-BR') +
      ' (entre ' + antes.v.toLocaleString('pt-BR') + ' e ' + depois.v.toLocaleString('pt-BR') + ')');
  });
  return preenchidos;
}

async function main(){
  const now = new Date();

  // Grava sempre o dia anterior, já fechado. O agendamento do GitHub Actions
  // atrasa com frequência; mirar no dia de hoje fazia a captura cair no dia
  // errado quando o atraso passava da meia-noite.
  const ontem = new Date(brazilDayStart(now).getTime() - 1000);
  const todayKey = brazilDateKey(ontem);
  const dayStart = brazilDayStart(ontem);
  const since = Math.floor(dayStart.getTime() / 1000);
  const until = since + 86400;

  console.log('Capturando o dia', todayKey, '(janela', new Date(since*1000).toISOString(), '->', new Date(until*1000).toISOString() + ')');

  const profile = await fetchGraph('/' + IG_USER_ID, { fields: 'followers_count,media_count,username' });

  // Janela explícita: sem since/until a Meta devolve o último dia disponível,
  // que caía sob a data errada no histórico.
  const reach = await totalValue('reach', since, until);
  const totalInteractions = await totalValue('total_interactions', since, until);

  const views = await totalValue('views', since, until);

  let postsToday = 0;
  let reelsToday = 0;
  let reelViews = null;
  try{
    const media = await fetchMediaDoDia(since);
    const todayMedia = media.filter(m => brazilDateKey(new Date(m.timestamp)) === todayKey);
    postsToday = todayMedia.length;

    const videos = todayMedia.filter(m => m.media_product_type === 'REELS' || m.media_type === 'VIDEO');
    reelsToday = videos.length;

    if(videos.length){
      const results = await Promise.all(videos.map(async v => {
        for(const metric of ['views', 'plays', 'video_views']){
          try{
            const ins = await fetchGraph('/' + v.id + '/insights', { metric });
            const row = (ins.data || []).find(d => d.name === metric);
            const val = row && row.values && row.values[0] && row.values[0].value;
            if(typeof val === 'number') return val;
          }catch(e){ /* tenta a próxima métrica */ }
        }
        return null;
      }));
      const valid = results.filter(v => typeof v === 'number');
      if(valid.length) reelViews = valid.reduce((a, b) => a + b, 0);
    }
  }catch(e){ console.warn('Publicações falhou:', e.message); }

  const engagementRate = (totalInteractions !== null && reach) ? (totalInteractions / reach * 100) : null;

  console.log('=== DEBUG ===');
  console.log('Followers:', profile.followers_count);
  console.log('Reach:', reach);
  console.log('Views (conta):', views);
  console.log('Reel views (hoje):', reelViews, '/', reelsToday, 'reels');
  console.log('Posts today:', postsToday);
  console.log('Total interactions:', totalInteractions);
  console.log('Engagement rate:', engagementRate);

  // followers_count é instantâneo, não uma janela: só vale como fechamento do
  // dia alvo se a execução for logo depois da meia-noite. Num disparo manual
  // às 14h ele seria a contagem de hoje gravada sob a data de ontem.
  const ancoras = await lerAncoras();
  const naVirada = ancoraNaVirada(ancoras, until * 1000);

  const horasDepoisDoDia = (now.getTime() / 1000 - until) / 3600;
  const rodouPerto = horasDepoisDoDia <= 6;

  // Ordem de preferência: âncora colada na virada > leitura da própria
  // execução, se ela rodou perto > nada (aí interpola depois).
  let followersDoDia = null;
  if(naVirada){
    followersDoDia = naVirada.valor;
    console.log('Fechamento de ' + todayKey + ' pela âncora de ' + naVirada.distMin +
      ' min da virada: ' + naVirada.valor.toLocaleString('pt-BR'));
  }else if(rodouPerto){
    followersDoDia = profile.followers_count ?? null;
    console.log('Fechamento de ' + todayKey + ' pela leitura desta execução (' +
      horasDepoisDoDia.toFixed(1) + 'h depois da virada).');
  }else{
    console.warn('Sem âncora perto da virada e execução ' + horasDepoisDoDia.toFixed(1) +
      'h atrasada; o fechamento de ' + todayKey + ' vai ser interpolado.');
  }

  const followersConfiavel = followersDoDia !== null;

  // Mesmo recusando o valor como fechamento, guarda a leitura com a hora em
  // que foi feita. Ela é uma medição real, só de outro momento — serve de
  // âncora pra estimar o dia que ficou sem valor.
  const ancoraFallback = followersConfiavel ? null : {
    valor: profile.followers_count ?? null,
    quando: now.toISOString()
  };

  const entry = {
    date: todayKey,
    followers: followersDoDia,
    followersRef: ancoraFallback,
    reach: reach ?? null,
    views: views ?? null,
    reelViews: reelViews ?? null,
    reels: reelsToday,
    posts: postsToday,
    interactions: totalInteractions,
    engagementRate: engagementRate
  };

  const fs = await import('node:fs/promises');
  const path = new URL('../history.json', import.meta.url);
  let history = [];
  try{ history = JSON.parse(await fs.readFile(path, 'utf8')); }catch(e){ history = []; }

  // Valida: se algum dado crítico falha, mantém o anterior
  const idx = history.findIndex(h => h.date === entry.date);
  if(idx >= 0){
    const prev = history[idx];
    // Se followers_count veio null, usa o anterior
    if(entry.followers === null && prev.followers !== null){
      entry.followers = prev.followers;
      // Se o que havia era estimativa, continua sendo
      if(prev.followersEstimado) entry.followersEstimado = true;
    }
    // Idem pras visualizações: não sobrescreve valor bom com null
    if(entry.views === null && prev.views != null){
      entry.views = prev.views;
    }
    history[idx] = entry;
  }else{
    history.push(entry);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));

  const lacunas = preencherLacunas(history, ancoras);
  if(lacunas) console.log('Lacunas de seguidores preenchidas:', lacunas);

  // Recupera dias antigos: as métricas de janela (alcance, visualizações,
  // interações) eram buscadas sem since/until e caíam sob a data errada, e
  // pedir duas métricas juntas fazia a chamada inteira falhar. Aqui elas são
  // refeitas com a janela explícita de cada dia, que é a fonte autoritativa.
  // Seguidores não dá pra recuperar: é um valor instantâneo, não uma janela.
  const alvos = history.slice(-BACKFILL_DAYS).filter(h => h.date !== todayKey);
  let corrigidos = 0;
  for(const h of alvos){
    const s = Math.floor(new Date(h.date + 'T00:00:00-03:00').getTime() / 1000);
    const u = s + 86400;
    const [r, v, i] = [
      await totalValue('reach', s, u),
      await totalValue('views', s, u),
      await totalValue('total_interactions', s, u)
    ];
    // Só sobrescreve com valor bom; um null da API não apaga o que já existe.
    let mudou = false;
    if(r !== null && r !== h.reach){ h.reach = r; mudou = true; }
    if(v !== null && v !== h.views){ h.views = v; mudou = true; }
    if(i !== null && i !== h.interactions){ h.interactions = i; mudou = true; }
    if(mudou){
      h.engagementRate = (h.interactions != null && h.reach) ? (h.interactions / h.reach * 100) : h.engagementRate ?? null;
      corrigidos++;
      console.log('  corrigido', h.date, '-> alcance', h.reach, '| views', h.views, '| interacoes', h.interactions);
    }
  }
  if(corrigidos) console.log('Backfill ajustou', corrigidos, 'dia(s).');

  if(history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  await fs.writeFile(path, JSON.stringify(history, null, 2) + '\n');
  console.log('Snapshot salvo:', JSON.stringify(entry));

  // Ranking das publicações do dia, guardado pro dashboard somar por período.
  // Fazer isso ao vivo pra 30 dias seriam ~1200 chamadas, inviável no navegador.
  try{
    const midiaDoDia = (await fetchMediaDoDia(since))
      .filter(m => brazilDateKey(new Date(m.timestamp)) === todayKey);
    const comMetricas = (await mapLimit(midiaDoDia, 6, m => metricasDaMidia(m))).filter(Boolean);
    comMetricas.sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1));
    const topDoDia = comMetricas.slice(0, TOP_POR_DIA);

    const topPath = new URL('../top-posts.json', import.meta.url);

    // Arquivo do mês: o top-posts.json mantém só a janela recente (o painel
    // baixa ele a cada carregamento e já está em centenas de KB). Os meses
    // fechados vão pra arquivos próprios, buscados só quando alguém gera o
    // relatório daquele mês — assim agosto continua disponível em dezembro.
    try{
      const ym = todayKey.slice(0, 7);
      const mesPath = new URL('../meses/' + ym + '.json', import.meta.url);
      let doMes = { mes: ym, posts: [] };
      try{ doMes = JSON.parse(await fs.readFile(mesPath, 'utf8')); }catch(e){}
      const porId = new Map();
      [...(doMes.posts || []), ...topDoDia].forEach(p => { if(p && p.id) porId.set(p.id, p); });
      const lista = [...porId.values()].sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1));
      await fs.mkdir(new URL('../meses/', import.meta.url), { recursive: true });
      await fs.writeFile(mesPath, JSON.stringify(
        { mes: ym, posts: lista, atualizado: new Date().toISOString() }, null, 2) + String.fromCharCode(10));
      console.log('Arquivo de', ym + ':', lista.length, 'publicações.');
    }catch(e){ console.warn('Arquivo do mês falhou:', e.message); }
    let top = { recentes: [], allTime: [] };
    try{ top = JSON.parse(await fs.readFile(topPath, 'utf8')); }catch(e){}

    const limite = new Date(new Date(todayKey + 'T12:00:00Z').getTime() - JANELA_TOP * 86400000)
      .toISOString().slice(0, 10);
    const atualizado = mesclaTop(top, topDoDia, limite);
    await fs.writeFile(topPath, JSON.stringify(atualizado, null, 2) + '\n');
    console.log('Top do dia:', topDoDia.length, 'publicações |',
      atualizado.recentes.length, 'em', JANELA_TOP, 'dias |', atualizado.allTime.length, 'no all-time');
  }catch(e){ console.warn('Ranking do dia falhou:', e.message); }
}

// Só executa quando chamado direto. O backfill importa as funções daqui e
// não pode disparar uma captura como efeito colateral do import.
const chamadoDireto = process.argv[1] &&
  import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href;

if(chamadoDireto){
  main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
}
