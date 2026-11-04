const fs = require('node:fs');
const path = require('node:path');
const { exigirLogin } = require('../lib/auth');

// Serve os arquivos de dados por trás do login.
//
// Antes o public.html buscava history.json, top-posts.json e companhia direto
// no raw.githubusercontent.com. Isso tinha dois problemas: qualquer pessoa com
// a URL baixava o acervo inteiro da conta sem senha nenhuma, e o painel só
// funcionava enquanto o repositório fosse público. Agora os dois somem de uma
// vez — o conteúdo passa pelo mesmo guarda dos outros endpoints e vem do disco
// do próprio deploy, sem depender do GitHub.
//
//   /api/arquivo?f=history
//   /api/arquivo?f=meses/2026-10

// Lista fechada. Nada fora daqui é servido, e os nomes não aceitam caminho,
// então não há como pedir ../lib/auth.js ou qualquer outra coisa do deploy.
const PERMITIDOS = new Set([
  'history',
  'top-posts',
  'stories-diario',
  'stories-recentes',
  'demografia',
  'anchors',
]);

const MES = /^meses\/\d{4}-\d{2}$/;

function resolver(f) {
  if (typeof f !== 'string' || f.length > 40) return null;
  if (PERMITIDOS.has(f)) return f + '.json';
  if (MES.test(f)) return f + '.json';
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  res.setHeader('Content-Type', 'application/json');

  if (!exigirLogin(req, res)) return;

  const rel = resolver(req.query && req.query.f);
  if (!rel) {
    res.status(400).json({ error: 'arquivo-invalido' });
    return;
  }

  // process.cwd() na Vercel é a raiz do deploy, onde ficam os .json do repo.
  const completo = path.join(process.cwd(), rel);

  try {
    const conteudo = fs.readFileSync(completo, 'utf8');
    // Os arquivos mudam no máximo de 3 em 3 horas; um minuto de cache corta
    // repetição sem atrasar o que o telão mostra.
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).send(conteudo);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Mês sem arquivo é situação normal, não erro: o painel trata como vazio.
      res.status(404).json({ error: 'nao-encontrado', arquivo: rel });
      return;
    }
    console.error('arquivo error:', rel, e.message);
    res.status(500).json({ error: 'falha-ao-ler' });
  }
};
