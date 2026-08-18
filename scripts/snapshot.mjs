const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';
const TZ = 'America/Sao_Paulo';
const HISTORY_LIMIT = 800;

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

async function main(){
  const now = new Date();
  const todayKey = brazilDateKey(now);
  const dayStart = brazilDayStart(now);

  const profile = await fetchGraph('/' + IG_USER_ID, { fields: 'followers_count,media_count,username' });

  let reach = null;
  try{
    const insights = await fetchGraph('/' + IG_USER_ID + '/insights', { metric: 'reach', period: 'day' });
    const vals = insights.data && insights.data[0] && insights.data[0].values;
    if(vals && vals.length) reach = vals[vals.length - 1].value;
  }catch(e){ console.warn('Alcance falhou:', e.message); }

  let totalInteractions = null;
  try{
    const since = Math.floor(dayStart.getTime() / 1000);
    const until = Math.floor(now.getTime() / 1000);
    const insights2 = await fetchGraph('/' + IG_USER_ID + '/insights', {
      metric: 'accounts_engaged,total_interactions',
      metric_type: 'total_value', period: 'day', since: String(since), until: String(until)
    });
    (insights2.data || []).forEach(m => {
      if(m.name === 'total_interactions' && m.total_value && typeof m.total_value.value === 'number'){
        totalInteractions = m.total_value.value;
      }
    });
  }catch(e){ console.warn('Engajamento falhou:', e.message); }

  let postsToday = 0;
  try{
    const media = await fetchGraph('/' + IG_USER_ID + '/media', { fields: 'id,timestamp', limit: '50' });
    postsToday = (media.data || []).filter(m => brazilDateKey(new Date(m.timestamp)) === todayKey).length;
  }catch(e){ console.warn('Publicações falhou:', e.message); }

  const engagementRate = (totalInteractions !== null && reach) ? (totalInteractions / reach * 100) : null;

  console.log('=== DEBUG ===');
  console.log('Followers:', profile.followers_count);
  console.log('Reach:', reach);
  console.log('Posts today:', postsToday);
  console.log('Total interactions:', totalInteractions);
  console.log('Engagement rate:', engagementRate);

  const entry = {
    date: todayKey,
    followers: profile.followers_count ?? null,
    reach: reach ?? null,
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
    history[idx] = entry;
  }else{
    history.push(entry);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));
  if(history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  await fs.writeFile(path, JSON.stringify(history, null, 2) + '\n');
  console.log('Snapshot salvo:', JSON.stringify(entry));
}

main().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
