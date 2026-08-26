const { exigirLogin } = require('../lib/auth');
// Demografia da base de seguidores: idade, gênero, cidade e país.
// É um retrato lifetime que muda devagar, então o cache é longo — não faz
// sentido consultar a Meta a cada carregamento pra um número que anda por mês.
const TOKEN = process.env.IG_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const API_VERSION = 'v22.0';

const cache = { data: null, time: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

async function fetchGraph(path, params) {
  const url = new URL('https://graph.facebook.com/' + API_VERSION + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', TOKEN);
  const res = await fetch(url.toString());
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch (e) { throw new Error('Resposta inválida da Meta'); }
  if (json.error) throw new Error(json.error.message || 'Erro na API da Meta');
  return json;
}

async function porBreakdown(breakdown) {
  const r = await fetchGraph('/' + IG_USER_ID + '/insights', {
    metric: 'follower_demographics',
    period: 'lifetime',
    metric_type: 'total_value',
    timeframe: 'this_month',
    breakdown
  });
  const linha = (r.data || [])[0];
  const b = linha && linha.total_value && linha.total_value.breakdowns
    ? linha.total_value.breakdowns[0] : null;
  if (!b) return [];
  return (b.results || [])
    .map(x => ({ chave: x.dimension_values[0], valor: x.value }))
    .filter(x => typeof x.valor === 'number')
    .sort((a, b2) => b2.valor - a.valor);
}

// Faixas etárias saem fora de ordem da API; ordem cronológica lê melhor
const ORDEM_IDADE = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (!exigirLogin(req, res)) return;

  try {
    const agora = Date.now();
    if (cache.data && agora - cache.time < CACHE_TTL) {
      res.status(200).json(cache.data);
      return;
    }

    const [idade, genero, cidade, pais] = await Promise.all([
      porBreakdown('age').catch(() => []),
      porBreakdown('gender').catch(() => []),
      porBreakdown('city').catch(() => []),
      porBreakdown('country').catch(() => [])
    ]);

    idade.sort((a, b) => ORDEM_IDADE.indexOf(a.chave) - ORDEM_IDADE.indexOf(b.chave));

    const total = g => g.reduce((a, x) => a + x.valor, 0);

    const payload = {
      idade,
      genero: genero.map(g => ({
        chave: g.chave === 'F' ? 'Feminino' : g.chave === 'M' ? 'Masculino' : 'Não informado',
        valor: g.valor
      })),
      // Nomes de cidade vêm como "São Paulo, São Paulo (state)"
      cidade: cidade.slice(0, 8).map(c => ({
        chave: c.chave.replace(/,\s*[^,]*\(state\)$/, ''),
        uf: (c.chave.match(/,\s*(.+?)\s*\(state\)$/) || [])[1] || null,
        valor: c.valor
      })),
      pais: pais.slice(0, 8),
      totais: {
        idade: total(idade),
        genero: total(genero),
        cidade: total(cidade),
        pais: total(pais)
      },
      timestamp: new Date().toISOString()
    };

    cache.data = payload;
    cache.time = agora;
    res.status(200).json(payload);
  } catch (e) {
    console.error('Audience error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
