const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';
const HISTORY_LIMIT = 800;
// Quantos dias recentes reconferir a cada execução. A Meta guarda insights
// por ~2 anos, mas 30 dias cobre o estrago sem estourar o limite de chamadas.
const BACKFILL_DAYS = 30;

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
    const media = await fetchGraph('/' + IG_USER_ID + '/media', {
      fields: 'id,timestamp,media_type,media_product_type', limit: '50'
    });
    const todayMedia = (media.data || []).filter(m => brazilDateKey(new Date(m.timestamp)) === todayKey);
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

  const entry = {
    date: todayKey,
    followers: profile.followers_count ?? null,
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
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
