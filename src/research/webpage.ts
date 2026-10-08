// Adaptado do saas/src/lib/webpage.ts; atualizar com scripts/sync-research.mjs.
// Endereços e termos. Só isso.
//
// Duas coisas que continuam verdadeiras com navegador ou sem ele, com cascata
// ou sem ela, e que por isso não moram junto de nenhum dos dois:
//
//   1. ENDEREÇO NÃO CONFIÁVEL. Quem escolhe para onde navegar é o MODELO, a
//      partir de links que ele leu numa página da internet. `isPrivateHost` é
//      o que impede esse endereço de apontar para dentro da máquina — um
//      "resultado" para 127.0.0.1:5001 faria este processo buscar o llama.cpp
//      interno e despejar a resposta no prompt.
//   2. ENDEREÇO COLADO PELO USUÁRIO. Separar link de frase é o mesmo problema
//      de sempre, e `splitUrls` é onde ele está resolvido.
//
// ---- O que saiu daqui, e para onde ----
//
// A extração de texto de página — `stripHtml`, `extractArticle`,
// `relevantWindow`, `pageText`, mais uma instância de Turndown e o pipeline do
// Readability — foi embora com a chegada de `lib/websearch.ts`, que traz a sua
// própria. Eram DUAS implementações da mesma coisa no mesmo processo, e a
// daqui não tinha mais nenhum chamador depois que `lib/browsing.ts` saiu.

/*
 * O que NÃO pode ser visitado, nunca.
 *
 * Um "resultado" apontando para 127.0.0.1:5001 faria este processo buscar o
 * llama.cpp interno e despejar a resposta no prompt; 169.254.169.254 é o
 * endereço de metadados de nuvem, que devolve credencial. Como quem escolhe o
 * endereço é o modelo — a partir de links que ele leu na internet —, a régua
 * vale para TODA navegação, não só para a primeira.
 */
const PRIVATE_HOSTNAMES =
  /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOSTNAMES.test(host) || PRIVATE_HOSTNAMES.test(`[${host}`)) return true;
  return /\.(?:local|internal|localdomain|home|lan|corp|intranet)$/i.test(host);
}

/** http(s) e host público. É a única porta por onde uma navegação passa. */
export function navigable(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return false;
  return !isPrivateHost(u.hostname);
}

const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

// A mensagem inteira é um domínio digitado sem esquema ("unsloth.ai",
// "github.com/unslothai/unsloth"). Só vale para a mensagem TODA: procurar isto
// no meio de uma frase transformaria "etc.pode acontecer" em endereço.
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?:\/\S*)?$/i;

function conta(texto: string, char: string): number {
  let n = 0;
  for (const c of texto) if (c === char) n++;
  return n;
}

/**
 * Tira a pontuação da frase que grudou no fim do endereço.
 *
 * "veja https://exemplo.com/artigo." termina em ponto, e o ponto não é do
 * endereço. Parêntese é o caso chato: em `.../Java_(linguagem)` ele faz parte;
 * em "(veja https://exemplo.com)" não faz. Quem decide é o balanceamento dentro
 * do próprio endereço.
 */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?"'»…]+$/, '');
  for (;;) {
    const fim = url.slice(-1);
    const abre = fim === ')' ? '(' : fim === ']' ? '[' : fim === '}' ? '{' : '';
    if (!abre) break;
    if (conta(url, abre) >= conta(url, fim)) break;
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url;
}

/**
 * Separa os ENDEREÇOS do resto do texto.
 *
 * Quem cola um link quer que AQUELA página seja lida. Mandar o endereço para o
 * buscador é o caminho errado, e dá para medir: em 21/08/2026,
 * "https://github.com/unslothai/unsloth" no Bing devolvia dez resultados sobre
 * o protocolo HTTPS — "https" é o termo mais genérico da consulta.
 */
export function splitUrls(text: string): { urls: string[]; rest: string } {
  const bruto = String(text ?? '');
  const urls: string[] = [];

  const rest = bruto.replace(URL_REGEX, (achado) => {
    const url = trimUrl(achado);
    const completa = /^www\./i.test(url) ? `https://${url}` : url;
    if (!urls.includes(completa)) urls.push(completa);
    return ` ${achado.slice(url.length)}`;
  }).replace(/\s+/g, ' ').trim();

  if (urls.length === 0 && BARE_DOMAIN.test(bruto.trim())) {
    return { urls: [`https://${bruto.trim()}`], rest: '' };
  }

  return { urls: urls.filter((u) => { try { return new URL(u).hostname.includes('.'); } catch { return false; } }), rest };
}

/** Só os endereços. Ver splitUrls. */
export function extractUrls(text: string): string[] {
  return splitUrls(text).urls;
}

/** Minúscula e sem acento. É a forma em que tudo aqui compara texto. */
export function normText(text: string): string {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const STOPWORDS = new Set(['de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'para', 'pra', 'por', 'com', 'sem', 'que', 'qual', 'quais', 'quem', 'quando', 'onde', 'como', 'foi', 'ser', 'tem', 'sao', 'esta', 'estao', 'sobre', 'mais', 'hoje', 'agora', 'atual', 'the', 'of', 'and', 'in', 'on', 'for', 'to', 'is', 'was', 'are', 'what', 'who', 'when', 'where', 'how', 'an', 'at', 'by', 'with']);

/**
 * Os termos que contam numa consulta.
 *
 * Serve para duas coisas: dizer se duas consultas são a mesma busca escrita de
 * outro jeito, e apontar onde recortar uma página longa.
 */
export function queryTerms(query: string): string[] {
  return [...new Set(normText(query) .split(/[^a-z0-9]+/) .filter((t) => (t.length >= 3 || /^\d{4}$/.test(t)) && !STOPWORDS.has(t)))];
}

/*
 * Casamento por PALAVRA, não por pedaço de palavra.
 *
 * Comparar com `includes` dá no mesmo para termo longo e é desastre para termo
 * curto: em "preço iPhone 17 Pro", "pro" casa "produto", "profile" e
 * "portfolio". O sufixo de até duas letras existe para plural e flexão
 * ("notebooks" para "notebook"); o de dígitos, para versão de nome próprio
 * ("Qwen" para "Qwen3"), e só quando o termo termina em letra — senão o "17" de
 * "iPhone 17" casaria o "17.500" de um preço.
 */
const TERM_REGEX = new Map<string, RegExp>();

function matcherFor(term: string): RegExp {
  let re = TERM_REGEX.get(term);
  if (!re) {
    const escapado = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /*
     * Termo que é SÓ número não pode casar o começo de um número maior.
     *
     * O "17" de "iPhone 17" casava o "17.500" de um preço, porque o ponto conta
     * como separador de palavra e o casamento terminava ali. A espiada adiante
     * recusa isso sem recusar "17 Pro", "17," nem "2026".
     */
    if (/^[0-9]+$/.test(term)) {
      re = new RegExp(`(?:^|[^a-z0-9])${escapado}(?![.,][0-9])(?:[^a-z0-9]|$)`, 'g');
      TERM_REGEX.set(term, re);
      re.lastIndex = 0;
      return re;
    }

    const sufixo = /[a-z]$/.test(term) ? '(?:[a-z]{0,2}|[0-9]{1,2}(?:[.][0-9])?)' : '[a-z]{0,2}';
    re = new RegExp(`(?:^|[^a-z0-9])${escapado}${sufixo}(?:[^a-z0-9]|$)`, 'g');
    TERM_REGEX.set(term, re);
  }
  re.lastIndex = 0;
  return re;
}

/** O termo aparece como palavra no texto? Normaliza os dois antes de olhar. */
export function mentionsTerm(text: string, term: string): boolean {
  return matcherFor(normText(term)).test(normText(text));
}
