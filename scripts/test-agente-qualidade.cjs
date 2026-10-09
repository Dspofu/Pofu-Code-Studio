// Qualidade do agente com modelo REAL, dentro do app: achar a causa de um bug, consertar sem
// mexer no teste, escrever testes que pegam bugs e revisar sem alterar. A nota é objetiva e
// calculada FORA da conversa: testes ocultos que o agente nunca vê e mutantes plantados no
// código para medir se os testes dele detectam erro. Mesmas variáveis do test:agent.
// POFU_TEST_THINK, POFU_TEST_CENARIOS (nomes separados por vírgula) e POFU_TEST_REPORT opcionais.
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const endpoint = process.env.POFU_TEST_API_URL, key = process.env.POFU_TEST_API_KEY;
if (!endpoint || !key) { console.error('Set POFU_TEST_API_URL and POFU_TEST_API_KEY. This test makes real API requests.'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pofu-qualidade-'));
const workspace = join(profile, 'loja'), ocultos = join(profile, 'ocultos');
mkdirSync(ocultos);
app.setPath('userData', profile);
Notification.prototype.show = () => {};
app.on('browser-window-created', (_, win) => win.hide());
const originalFetch = global.fetch;
global.fetch = (url, ...args) => String(url).startsWith('https://api.github.com/repos/') ? Promise.resolve(new Response('{}', { status: 404 })) : originalFetch(url, ...args);

const CARRINHO = `const CUPONS = { DEZ: 0.1, VINTE: 0.2 };

function subtotal(itens) {
  return itens.reduce((soma, item) => soma + item.preco * item.qtd, 0);
}

// Frete grátis quando o subtotal da compra (antes do cupom) chega a R$ 200.
function frete(valor) {
  return valor >= 200 ? 0 : 15;
}

function total(itens, cupom) {
  const bruto = subtotal(itens);
  const desconto = CUPONS[cupom] ? bruto * CUPONS[cupom] : 0;
  const liquido = bruto - desconto;
  return Math.round((liquido + frete(liquido)) * 100) / 100;
}

module.exports = { subtotal, frete, total, CUPONS };
`;
const ESTOQUE = `function reserva(estoque, sku, qtd) {
  if (!Number.isInteger(qtd) || qtd <= 0) throw new Error('quantidade inválida');
  const atual = estoque[sku] ?? 0;
  if (atual < qtd - 1) throw new Error('estoque insuficiente');
  return { ...estoque, [sku]: atual - qtd };
}

function devolve(estoque, sku, qtd) {
  if (!Number.isInteger(qtd) || qtd <= 0) throw new Error('quantidade inválida');
  return { ...estoque, [sku]: (estoque[sku] ?? 0) + qtd };
}

module.exports = { reserva, devolve };
`;
const DATAS = `function partes(data) {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(data);
  if (!m) throw new TypeError('data inválida: ' + data);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

function diasEntre(inicio, fim) {
  const a = Date.UTC(...partes(inicio)), b = Date.UTC(...partes(fim));
  if (b < a) throw new RangeError('fim antes do início');
  return Math.round((b - a) / 86400000);
}

function ehBissexto(ano) {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

// Soma n dias úteis (segunda a sexta) a partir de uma data; n = 0 devolve a própria data.
function adicionaDiasUteis(data, n) {
  const d = new Date(Date.UTC(...partes(data)));
  let restantes = n;
  while (restantes > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dia = d.getUTCDay();
    if (dia !== 0 && dia !== 6) restantes--;
  }
  return d.toISOString().slice(0, 10);
}

module.exports = { diasEntre, ehBissexto, adicionaDiasUteis };
`;
const PARCELAS = `function parcelas(total, n) {
  const valor = Math.floor((total / n) * 100) / 100;
  return Array.from({ length: n }, () => valor);
}

module.exports = { parcelas };
`;
const MUTANTES_DATAS = [
  ['400 anos é bissexto', '|| ano % 400 === 0', ''],
  ['100 anos não é bissexto', '(ano % 4 === 0 && ano % 100 !== 0)', '(ano % 4 === 0)'],
  ['fim antes do início', "if (b < a) throw new RangeError('fim antes do início');", ''],
  ['diferença sem +1', 'return Math.round((b - a) / 86400000);', 'return Math.round((b - a) / 86400000) + 1;'],
  ['sábado não é útil', 'dia !== 0 && dia !== 6', 'dia !== 0'],
  ['n = 0 devolve a data', 'while (restantes > 0) {', 'do {'],
];
MUTANTES_DATAS[5].push('    if (dia !== 0 && dia !== 6) restantes--;\n  }', '    if (dia !== 0 && dia !== 6) restantes--;\n  } while (restantes > 0);');

function preparaWorkspace() {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(join(workspace, 'src'), { recursive: true }); mkdirSync(join(workspace, 'test'));
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'loja', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  writeFileSync(join(workspace, 'src', 'carrinho.js'), CARRINHO);
  writeFileSync(join(workspace, 'src', 'estoque.js'), ESTOQUE);
  writeFileSync(join(workspace, 'src', 'datas.js'), DATAS);
  writeFileSync(join(workspace, 'src', 'parcelas.js'), PARCELAS);
  writeFileSync(join(workspace, 'test', 'carrinho.test.js'), `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { total } = require('../src/carrinho');\n\ntest('sem cupom e abaixo de 200 cobra frete', () => {\n  assert.equal(total([{ preco: 50, qtd: 1 }]), 65);\n});\n`);
  writeFileSync(join(workspace, 'test', 'estoque.test.js'), `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { reserva } = require('../src/estoque');\n\ntest('reserva desconta do estoque', () => {\n  assert.deepEqual(reserva({ A: 5 }, 'A', 2), { A: 3 });\n});\n\ntest('não reserva mais do que existe', () => {\n  assert.throws(() => reserva({ A: 4 }, 'A', 5), /insuficiente/);\n});\n`);
}

function rodaTestes(arquivos, cwd = workspace) {
  const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', ['--test', ...arquivos], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const saida = (r.stdout || '') + (r.stderr || '');
  const n = k => Number((saida.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) || [])[1] || 0);
  return { ok: r.status === 0, pass: n('pass'), fail: n('fail'), saida };
}

function oculto(nome, corpo) {
  const f = join(ocultos, nome);
  writeFileSync(f, `const test = require('node:test');\nconst assert = require('node:assert/strict');\n${corpo.replace(/'SRC\/(\w+)'/g, (_, m) => JSON.stringify(join(workspace, 'src', m)))}`);
  return f;
}

const cenarios = [
  { nome: 'bug a partir de relato',
    prompt: 'Clientes estão reclamando do total do carrinho. Exemplo: 2 itens de R$ 105 com o cupom DEZ deveriam dar R$ 189,00 (o frete é grátis porque a compra passou de R$ 200), mas o carrinho mostra R$ 204,00. Encontre a causa e corrija.',
    avalia: () => {
      const r = rodaTestes([oculto('carrinho.oculto.test.js', `const { total, frete } = require('SRC/carrinho');
test('relato', () => assert.equal(total([{ preco: 105, qtd: 2 }], 'DEZ'), 189));
test('frete grátis exatamente em 200', () => assert.equal(total([{ preco: 100, qtd: 2 }]), 200));
test('abaixo de 200 sem cupom', () => assert.equal(total([{ preco: 199.99, qtd: 1 }]), 214.99));
test('cupom VINTE abaixo de 200', () => assert.equal(total([{ preco: 100, qtd: 1 }], 'VINTE'), 95));
test('cupom inexistente', () => assert.equal(total([{ preco: 300, qtd: 1 }], 'NADA'), 300));
test('frete puro', () => { assert.equal(frete(200), 0); assert.equal(frete(199.99), 15); });`)]);
      return { nota: r.pass / 6, detalhe: `${r.pass}/6 testes ocultos`, passou: r.ok };
    } },
  { nome: 'teste falhando sem pista',
    prompt: 'O npm test deste projeto está falhando. Descubra por quê e corrija o código. Não altere os testes.',
    avalia: () => {
      const testeIntacto = readFileSync(join(workspace, 'test', 'estoque.test.js'), 'utf8').includes("assert.throws(() => reserva({ A: 4 }, 'A', 5), /insuficiente/)");
      const r = rodaTestes([oculto('estoque.oculto.test.js', `const { reserva, devolve } = require('SRC/estoque');
test('pedido maior que o estoque', () => assert.throws(() => reserva({ A: 4 }, 'A', 5), /insuficiente/));
test('pedido igual ao estoque zera', () => assert.deepEqual(reserva({ A: 4 }, 'A', 4), { A: 0 }));
test('sku inexistente', () => assert.throws(() => reserva({}, 'X', 1), /insuficiente/));
test('não muta o original', () => { const e = { A: 3 }; reserva(e, 'A', 1); assert.deepEqual(e, { A: 3 }); });
test('quantidade inválida', () => { assert.throws(() => reserva({ A: 3 }, 'A', 0)); assert.throws(() => reserva({ A: 3 }, 'A', 1.5)); });
test('devolve soma', () => assert.deepEqual(devolve({ A: 1 }, 'A', 2), { A: 3 }));`)]);
      const suite = rodaTestes([]);
      return { nota: (r.pass / 6) * (testeIntacto ? 1 : 0), detalhe: `${r.pass}/6 ocultos · npm test ${suite.ok ? 'passa' : 'falha'} · teste ${testeIntacto ? 'intacto' : 'ALTERADO'}`, passou: r.ok && testeIntacto && suite.ok };
    } },
  { nome: 'criar testes que pegam bugs',
    prompt: 'Escreva testes para src/datas.js usando node:test (o runner que o projeto já usa), num arquivo novo em test/. Rode-os e garanta que passam.',
    avalia: () => {
      const proprios = readdirSync(join(workspace, 'test')).filter(f => !/^(carrinho|estoque)\.test\.js$/.test(f)).map(f => 'test/' + f);
      if (!proprios.length) return { nota: 0, detalhe: 'nenhum arquivo de teste criado', passou: false };
      const base = rodaTestes(proprios);
      if (!base.ok) return { nota: 0, detalhe: `os testes dele falham no código correto (${base.fail} falhas)`, passou: false };
      const caminho = join(workspace, 'src', 'datas.js'), original = readFileSync(caminho, 'utf8');
      const mortos = [];
      for (const [nome, ...trocas] of MUTANTES_DATAS) {
        let mutado = original;
        for (let i = 0; i < trocas.length; i += 2) mutado = mutado.replace(trocas[i], trocas[i + 1]);
        if (mutado === original) throw new Error('mutante não aplicou: ' + nome);
        writeFileSync(caminho, mutado);
        if (!rodaTestes(proprios).ok) mortos.push(nome);
        writeFileSync(caminho, original);
      }
      const vivos = MUTANTES_DATAS.map(m => m[0]).filter(n => !mortos.includes(n));
      return { nota: mortos.length / MUTANTES_DATAS.length, detalhe: `${base.pass} testes · pegou ${mortos.length}/${MUTANTES_DATAS.length} mutantes${vivos.length ? ' · escaparam: ' + vivos.join(', ') : ''}`, passou: mortos.length === MUTANTES_DATAS.length };
    } },
  { nome: 'revisão sem alterar',
    prompt: 'Revise src/parcelas.js e aponte os problemas que você encontrar, com um exemplo concreto de cada. Não altere nenhum arquivo.',
    avalia: (resposta) => {
      const intacto = readFileSync(join(workspace, 'src', 'parcelas.js'), 'utf8') === PARCELAS;
      const centavos = /centavo|arredond|soma das parcelas|não (soma|bate)|perde|0[.,]01|33[.,]33/i.test(resposta);
      const zero = /\b(n|parcelas?)\s*(=|igual a|é)\s*0\b|zero|negativ|divis[ãa]o por|Infinity|RangeError|Invalid array length/i.test(resposta);
      return { nota: ((centavos ? 1 : 0) + (zero ? 1 : 0)) / 2 * (intacto ? 1 : 0), detalhe: `centavos ${centavos ? 'sim' : 'NÃO'} · n inválido ${zero ? 'sim' : 'NÃO'} · arquivo ${intacto ? 'intacto' : 'ALTERADO'}`, passou: centavos && zero && intacto };
    } },
];

// Nível difícil: onde agentes costumam errar — causa longe do sintoma, assíncrono, relato que
// culpa o código errado, limites sutis e revisão de efeito colateral.
const PRECOS = `const TABELA = { sul: 1.0, norte: 1.18 };
const cache = {};

function precoBase(produto) {
  return produto.custo * 1.5;
}

// Preço final para a região; o cálculo é caro no sistema real, por isso o cache.
function precoFinal(produto, regiao) {
  if (cache[produto.id] !== undefined) return cache[produto.id];
  const valor = Math.round(precoBase(produto) * TABELA[regiao] * 100) / 100;
  cache[produto.id] = valor;
  return valor;
}

module.exports = { precoFinal };
`;
const FILA = `// Processa cada item com o worker (assíncrono) e devolve os resultados na mesma ordem.
async function processaTodos(itens, worker) {
  const resultados = [];
  itens.forEach(async (item) => {
    resultados.push(await worker(item));
  });
  return resultados;
}

module.exports = { processaTodos };
`;
const DESCONTO = `/**
 * Aplica um desconto percentual.
 * @param {number} preco valor em reais
 * @param {number} pct percentual de 0 a 100 (10 = 10%)
 */
function aplicaDesconto(preco, pct) {
  return Math.round(preco * (1 - pct / 100) * 100) / 100;
}

module.exports = { aplicaDesconto };
`;
const CHECKOUT = `const { aplicaDesconto } = require('./desconto');

function precoNatal(preco) {
  return aplicaDesconto(preco, 15);
}

function precoCupom(preco, cupom) {
  return cupom === 'BEMVINDO' ? aplicaDesconto(preco, 10) : preco;
}

function precoPromoRelampago(preco) {
  return aplicaDesconto(preco, 0.1);
}

module.exports = { precoNatal, precoCupom, precoPromoRelampago };
`;
const PAGINACAO = `// Página n (começando em 1) de uma lista. n fora do intervalo é ajustado para o limite.
function pagina(lista, n, tamanho = 10) {
  const paginas = Math.ceil(lista.length / tamanho);
  const atual = Math.min(Math.max(n, 1), Math.max(paginas, 1));
  const inicio = (atual - 1) * tamanho;
  return {
    itens: lista.slice(inicio, inicio + tamanho),
    pagina: atual,
    paginas,
    temProxima: atual < paginas,
  };
}

module.exports = { pagina };
`;
const MUTANTES_PAGINACAO = [
  ['ceil vira floor', 'Math.ceil(lista.length / tamanho)', 'Math.floor(lista.length / tamanho)'],
  ['n abaixo de 1 não ajusta', 'Math.max(n, 1)', 'n'],
  ['n acima do total não ajusta', 'Math.min(Math.max(n, 1), Math.max(paginas, 1))', 'Math.max(n, 1)'],
  ['temProxima com <=', 'atual < paginas', 'atual <= paginas'],
  ['tamanho padrão 20', 'tamanho = 10', 'tamanho = 20'],
  ['início sem -1', '(atual - 1) * tamanho', 'atual * tamanho'],
];
const RELATORIO = `function topVendedores(vendas, n = 3) {
  const ordenado = vendas.sort((a, b) => b.total - a.total);
  return ordenado.slice(0, n).map(v => v.nome);
}

// vendas: [{ nome, total, data: 'AAAA-MM-DD' }] -> total por mês (0 = janeiro)
function totalPorMes(vendas) {
  const meses = {};
  for (const v of vendas) {
    const mes = new Date(v.data).getMonth();
    meses[mes] = (meses[mes] || 0) + v.total;
  }
  return meses;
}

function percentual(parte, total) {
  return Math.round((parte / total) * 100);
}

module.exports = { topVendedores, totalPorMes, percentual };
`;
function preparaDificil() {
  writeFileSync(join(workspace, 'src', 'precos.js'), PRECOS);
  writeFileSync(join(workspace, 'src', 'fila.js'), FILA);
  writeFileSync(join(workspace, 'src', 'desconto.js'), DESCONTO);
  writeFileSync(join(workspace, 'src', 'checkout.js'), CHECKOUT);
  writeFileSync(join(workspace, 'src', 'paginacao.js'), PAGINACAO);
  writeFileSync(join(workspace, 'src', 'relatorio.js'), RELATORIO);
}
function mutacao(arquivo, mutantes, proprios) {
  const caminho = join(workspace, 'src', arquivo), original = readFileSync(caminho, 'utf8'), mortos = [];
  for (const [nome, de, para] of mutantes) {
    const mutado = original.replace(de, para);
    if (mutado === original) throw new Error('mutante não aplicou: ' + nome);
    writeFileSync(caminho, mutado);
    if (!rodaTestes(proprios).ok) mortos.push(nome);
    writeFileSync(caminho, original);
  }
  return mortos;
}
const dificeis = [
  { nome: 'causa longe do sintoma (cache)',
    prompt: 'Clientes da região norte às vezes veem o preço da região sul. Parece acontecer só depois que alguém do sul consultou o mesmo produto. Encontre a causa e corrija sem tirar o cache.',
    avalia: () => {
      const r = rodaTestes([oculto('precos.oculto.test.js', `const { precoFinal } = require('SRC/precos');
test('sul depois norte', () => { const p = { id: 1, custo: 100 }; assert.equal(precoFinal(p, 'sul'), 150); assert.equal(precoFinal(p, 'norte'), 177); });
test('norte depois sul', () => { const p = { id: 2, custo: 10 }; assert.equal(precoFinal(p, 'norte'), 17.7); assert.equal(precoFinal(p, 'sul'), 15); });
test('repetição estável', () => { const p = { id: 3, custo: 20 }; assert.equal(precoFinal(p, 'sul'), 30); assert.equal(precoFinal(p, 'sul'), 30); });
test('cache continua existindo', () => { const fs = require('node:fs'); assert.match(fs.readFileSync(require.resolve('SRC/precos'), 'utf8'), /cache/); });`)]);
      return { nota: r.pass / 4, detalhe: `${r.pass}/4 testes ocultos`, passou: r.ok };
    } },
  { nome: 'bug assíncrono',
    prompt: 'A função processaTodos em src/fila.js às vezes devolve a lista vazia ou incompleta. Encontre a causa, corrija, e prove com um teste.',
    avalia: () => {
      const r = rodaTestes([oculto('fila.oculto.test.js', `const { processaTodos } = require('SRC/fila');
const espera = (ms, v) => new Promise(ok => setTimeout(() => ok(v), ms));
test('todos os resultados', async () => assert.deepEqual(await processaTodos([1, 2, 3], x => espera(5, x * 2)), [2, 4, 6]));
test('ordem preservada com tempos diferentes', async () => assert.deepEqual(await processaTodos([30, 1, 15], x => espera(x, x)), [30, 1, 15]));
test('lista vazia', async () => assert.deepEqual(await processaTodos([], async x => x), []));
test('erro do worker propaga', async () => { await assert.rejects(processaTodos([1], async () => { throw new Error('falhou'); }), /falhou/); });`)]);
      return { nota: r.pass / 4, detalhe: `${r.pass}/4 testes ocultos`, passou: r.ok };
    } },
  { nome: 'relato que culpa a função errada',
    prompt: 'A função aplicaDesconto está com bug: aplicaDesconto(200, 0.1) devolve 199.8, mas um desconto de 10% em 200 deveria dar 180. A promoção relâmpago está saindo quase sem desconto. Corrija.',
    avalia: (resposta) => {
      const r = rodaTestes([oculto('desconto.oculto.test.js', `const { aplicaDesconto } = require('SRC/desconto');
const c = require('SRC/checkout');
test('contrato percentual mantido', () => { assert.equal(aplicaDesconto(200, 10), 180); assert.equal(aplicaDesconto(100, 15), 85); });
test('natal e cupom continuam certos', () => { assert.equal(c.precoNatal(100), 85); assert.equal(c.precoCupom(200, 'BEMVINDO'), 180); });
test('promoção relâmpago com 10%', () => assert.equal(c.precoPromoRelampago(200), 180));`)]);
      const explicou = /percentual|0 a 100|\b10\b.*(em vez|no lugar|ao invés)|chamad|precoPromoRelampago|checkout/i.test(resposta);
      return { nota: (r.pass / 3) * 0.8 + (explicou ? 0.2 : 0), detalhe: `${r.pass}/3 ocultos (contrato, outros chamadores, promoção) · explicou a causa ${explicou ? 'sim' : 'NÃO'}`, passou: r.ok && explicou };
    } },
  { nome: 'testes para limites sutis',
    prompt: 'Escreva testes para src/paginacao.js usando node:test, num arquivo novo em test/. Rode-os e garanta que passam.',
    avalia: () => {
      const proprios = readdirSync(join(workspace, 'test')).filter(f => !/^(carrinho|estoque)\.test\.js$/.test(f)).map(f => 'test/' + f);
      if (!proprios.length) return { nota: 0, detalhe: 'nenhum arquivo de teste criado', passou: false };
      const base = rodaTestes(proprios);
      if (!base.ok) return { nota: 0, detalhe: `os testes dele falham no código correto (${base.fail} falhas)`, passou: false };
      const mortos = mutacao('paginacao.js', MUTANTES_PAGINACAO, proprios);
      const vivos = MUTANTES_PAGINACAO.map(m => m[0]).filter(n => !mortos.includes(n));
      return { nota: mortos.length / MUTANTES_PAGINACAO.length, detalhe: `${base.pass} testes · pegou ${mortos.length}/${MUTANTES_PAGINACAO.length} mutantes${vivos.length ? ' · escaparam: ' + vivos.join(', ') : ''}`, passou: !vivos.length };
    } },
  { nome: 'revisão de efeitos sutis',
    prompt: 'Revise src/relatorio.js e aponte os problemas que você encontrar, com um exemplo concreto de cada. Não altere nenhum arquivo.',
    avalia: (resposta) => {
      const intacto = readFileSync(join(workspace, 'src', 'relatorio.js'), 'utf8') === RELATORIO;
      const muta = /mut|altera o (array|vetor)|in[- ]place|original|toSorted|\[\.\.\.vendas\]|slice\(\)\.sort|cópia/i.test(resposta);
      const fuso = /fuso|timezone|time zone|UTC|getUTCMonth/i.test(resposta);
      const zero = /zero|NaN|Infinity|divis/i.test(resposta);
      const achou = [muta, fuso, zero].filter(Boolean).length;
      return { nota: achou / 3 * (intacto ? 1 : 0), detalhe: `sort muta ${muta ? 'sim' : 'NÃO'} · fuso ${fuso ? 'sim' : 'NÃO'} · total zero ${zero ? 'sim' : 'NÃO'} · arquivo ${intacto ? 'intacto' : 'ALTERADO'}`, passou: achou === 3 && intacto };
    } },
];

function autoverificaDificil() {
  const casos = [];
  preparaWorkspace(); preparaDificil();
  for (const [i, nome] of [[0, 'cache'], [1, 'assíncrono'], [2, 'relato']]) casos.push([nome + ' sem correção reprova', !dificeis[i].avalia('').passou]);
  writeFileSync(join(workspace, 'src', 'precos.js'), PRECOS.replaceAll('cache[produto.id]', 'cache[produto.id + ":" + regiao]'));
  writeFileSync(join(workspace, 'src', 'fila.js'), FILA.replace(/itens\.forEach[\s\S]*?\}\);/, 'for (const item of itens) resultados.push(await worker(item));'));
  writeFileSync(join(workspace, 'src', 'checkout.js'), CHECKOUT.replace('aplicaDesconto(preco, 0.1)', 'aplicaDesconto(preco, 10)'));
  casos.push(['cache corrigido aprova', dificeis[0].avalia('').passou]);
  casos.push(['assíncrono corrigido aprova', dificeis[1].avalia('').passou]);
  casos.push(['relato com chamada corrigida aprova', dificeis[2].avalia('O problema está na chamada em checkout.js: a função espera percentual de 0 a 100.').passou]);
  writeFileSync(join(workspace, 'src', 'desconto.js'), DESCONTO.replace('pct / 100', 'pct'));
  casos.push(['relato com função "consertada" reprova', !dificeis[2].avalia('Corrigi a função.').passou]);
  writeFileSync(join(workspace, 'test', 'paginacao.test.js'), `const test = require('node:test');
const assert = require('node:assert/strict');
const { pagina } = require('../src/paginacao');
const l = Array.from({ length: 25 }, (_, i) => i);
test('primeira', () => { const p = pagina(l, 1); assert.deepEqual(p.itens, l.slice(0, 10)); assert.equal(p.paginas, 3); assert.equal(p.temProxima, true); });
test('última parcial', () => { const p = pagina(l, 3); assert.deepEqual(p.itens, [20, 21, 22, 23, 24]); assert.equal(p.temProxima, false); });
test('limites', () => { assert.equal(pagina(l, 0).pagina, 1); assert.equal(pagina(l, 9).pagina, 3); });
test('tamanho', () => assert.equal(pagina(l, 2, 5).itens[0], 5));
`);
  const t = dificeis[3].avalia('');
  casos.push(['testes de referência pegam os mutantes de paginação (' + t.detalhe + ')', t.passou]);
  casos.push(['revisão completa aprova', dificeis[4].avalia('sort altera o array original; getMonth usa o fuso local; total zero dá NaN').passou]);
  casos.push(['revisão parcial reprova', !dificeis[4].avalia('total zero dá NaN').passou]);
  for (const [nome, ok] of casos) console.log((ok ? 'PASS ' : 'FAIL ') + nome);
  return casos.every(c => c[1]);
}

// Sem modelo: o avaliador precisa reprovar o código com bug e aprovar o corrigido, senão a
// nota mediria o avaliador e não o agente.
function autoverifica() {
  const casos = [];
  preparaWorkspace();
  casos.push(['carrinho com bug reprova', !cenarios[0].avalia('').passou]);
  writeFileSync(join(workspace, 'src', 'carrinho.js'), CARRINHO.replace('frete(liquido)', 'frete(bruto)'));
  casos.push(['carrinho corrigido aprova', cenarios[0].avalia('').passou]);
  casos.push(['estoque com bug reprova', !cenarios[1].avalia('').passou]);
  writeFileSync(join(workspace, 'src', 'estoque.js'), ESTOQUE.replace('atual < qtd - 1', 'atual < qtd'));
  casos.push(['estoque corrigido aprova', cenarios[1].avalia('').passou]);
  writeFileSync(join(workspace, 'test', 'datas.test.js'), `const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/datas');
test('bissextos', () => { assert.equal(d.ehBissexto(2024), true); assert.equal(d.ehBissexto(1900), false); assert.equal(d.ehBissexto(2000), true); assert.equal(d.ehBissexto(2023), false); });
test('diasEntre', () => { assert.equal(d.diasEntre('2024-01-01', '2024-01-31'), 30); assert.equal(d.diasEntre('2024-01-01', '2024-01-01'), 0); assert.throws(() => d.diasEntre('2024-02-01', '2024-01-01'), RangeError); });
test('dias úteis', () => { assert.equal(d.adicionaDiasUteis('2024-06-07', 1), '2024-06-10'); assert.equal(d.adicionaDiasUteis('2024-06-07', 0), '2024-06-07'); assert.equal(d.adicionaDiasUteis('2024-06-03', 5), '2024-06-10'); });
`);
  const t = cenarios[2].avalia('');
  casos.push(['testes de referência pegam os 6 mutantes (' + t.detalhe + ')', t.passou]);
  casos.push(['revisão completa aprova', cenarios[3].avalia('A soma das parcelas perde centavos: 100 em 3 dá 33,33 x 3. Com n = 0 há divisão por zero.').passou]);
  casos.push(['revisão vazia reprova', !cenarios[3].avalia('Parece correto.').passou]);
  for (const [nome, ok] of casos) console.log((ok ? 'PASS ' : 'FAIL ') + nome);
  return casos.every(c => c[1]);
}

async function main() {
  const dificil = process.env.POFU_TEST_NIVEL === 'dificil';
  if (process.env.POFU_TEST_SELFCHECK) return dificil ? autoverificaDificil() : autoverifica();
  const models = await (await fetch(endpoint.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })).json();
  const model = process.env.POFU_TEST_MODEL || models.data?.[0]?.id;
  preparaWorkspace();
  let memoryStore = {
    settings: { apiUrl: endpoint, apiKey: key, model, execMode: 'auto', thinkLevel: process.env.POFU_TEST_THINK || 'muito_alto', maxTokens: 32768, temperature: 0.7, topP: 0.9, cmdTimeout: 20, hideCommandConsole: true },
    chats: { real: { id: 'real', name: 'Qualidade', path: workspace, messages: [] } }, activeChatId: 'real'
  };
  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => registerHandler(channel,
    channel === 'load-store' ? async () => memoryStore :
    channel === 'save-store' ? async (_, data) => { memoryStore = data; return { success: true }; } : handler);
  await import(pathToFileURL(resolve('out/main.js')));
  ipcMain.handle = registerHandler;
  await app.whenReady();
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  win.hide();
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`new Promise(ok => { const poll = () => document.getElementById('studio-model')?.textContent && !document.getElementById('user-input').disabled ? ok(true) : setTimeout(poll, 100); poll(); })`);

  const filtro = (process.env.POFU_TEST_CENARIOS || '').split(',').map(s => s.trim()).filter(Boolean);
  const relatorio = [];
  for (const c of (dificil ? dificeis : cenarios).filter(c => !filtro.length || filtro.some(f => c.nome.includes(f)))) {
    preparaWorkspace(); if (dificil) preparaDificil();
    await js(`import('./out/renderer.js').then(m => { const chat = m.activeChat(); chat.messages = []; chat.podaManualAte = 0; chat.podaAutoAte = 0; })`);
    const inicio = Date.now();
    await js(`(() => { const i = document.getElementById('user-input'); i.value = ${JSON.stringify(c.prompt)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => document.body.classList.contains('agent-running') || Date.now() - t0 > 5000 ? ok(true) : setTimeout(poll, 50); poll(); })`);
    await js(`new Promise(ok => { const t0 = Date.now(); const poll = () => !document.body.classList.contains('agent-running') || Date.now() - t0 > 1200000 ? ok(true) : setTimeout(poll, 300); poll(); })`);
    const msgs = await js(`import('./out/renderer.js').then(m => JSON.parse(JSON.stringify(m.activeChat().messages)))`);
    const chamadas = msgs.flatMap(m => (m.tool_calls || []).map(tc => ({ nome: tc.function.name, args: String(tc.function.arguments || '') })));
    const final = msgs.filter(m => m.role === 'assistant' && (m.content || '').trim()).pop();
    const resposta = String(final?.content || '').trim();
    let nota;
    try { nota = c.avalia(resposta); } catch (e) { nota = { nota: 0, detalhe: 'avaliação falhou: ' + e.message, passou: false }; }
    const rodouTestes = chamadas.some(x => x.nome === 'execute_command' && /test/i.test(x.args));
    const r = { cenario: c.nome, segundos: Math.round((Date.now() - inicio) / 1000), requisicoes: msgs.filter(m => m.role === 'assistant').length, chamadas: chamadas.map(x => x.nome), rodouTestes, ...nota, resposta: resposta.slice(0, 600) };
    relatorio.push(r);
    console.log(`${r.passou ? 'PASS' : 'FAIL'} ${c.nome} · nota ${Math.round(r.nota * 100)}% · ${r.detalhe} · ${r.segundos}s · ${r.requisicoes} requisições · rodou testes: ${rodouTestes ? 'sim' : 'não'}`);
    console.log(`     ferramentas: ${r.chamadas.join(' → ')}`);
    console.log(`     resposta: ${resposta.slice(0, 300).replace(/\n/g, ' ')}`);
  }
  const media = relatorio.reduce((a, r) => a + r.nota, 0) / relatorio.length;
  console.log(`RESULT nota média ${Math.round(media * 100)}% · ${relatorio.filter(r => r.passou).length}/${relatorio.length} cenários perfeitos`);
  if (process.env.POFU_TEST_REPORT) writeFileSync(process.env.POFU_TEST_REPORT, JSON.stringify({ model, relatorio, media }, null, 2));
  return true;
}
main().then(ok => app.exit(ok ? 0 : 1)).catch(err => { console.error(err); app.exit(1); });
