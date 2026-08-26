const { criarToken, credenciaisConferem, tokenValido } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  // Resposta de login nunca pode ficar em cache de CDN
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // GET serve pra saber se o login está ativo e se o token guardado ainda vale
  if (req.method === 'GET') {
    const ativo = !!(process.env.DASH_USER && process.env.DASH_PASS);
    const t = req.query && req.query.t;
    res.status(200).json({ ativo, valido: ativo ? tokenValido(t) : true });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'metodo-nao-permitido' });
    return;
  }

  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = {}; }
  }
  corpo = corpo || {};

  const r = credenciaisConferem(corpo.usuario, corpo.senha);

  if (r.motivo === 'nao-configurado') {
    res.status(200).json({
      ok: true,
      semLogin: true,
      aviso: 'DASH_USER e DASH_PASS não estão configurados na Vercel; o painel está aberto.'
    });
    return;
  }

  if (!r.ok) {
    // Atraso pequeno pra tornar tentativa em massa desinteressante
    await new Promise(resolve => setTimeout(resolve, 600));
    res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos' });
    return;
  }

  res.status(200).json({ ok: true, token: criarToken() });
};
