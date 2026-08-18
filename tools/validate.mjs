#!/usr/bin/env node
/**
 * Validação estática da extensão.
 *
 *   node tools/validate.mjs
 *
 * Checa o que o Chrome só reclamaria em tempo de execução:
 *   1. manifest.json válido e com todos os arquivos referenciados presentes;
 *   2. sintaxe de todos os .js (módulo para o service worker, script para o resto);
 *   3. todo `type:` enviado por sendMessage tem handler no background;
 *   4. todo id/classe usado pelo popup.js existe no popup.html;
 *   5. nenhuma escrita em innerHTML/outerHTML (superfície de XSS);
 *   6. nenhum @import de fonte remota no CSS (bloqueado pela CSP).
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (arquivo) => readFileSync(join(raiz, arquivo), 'utf8');

const erros = [];
const avisos = [];
const ok = [];

const falhar = (mensagem) => erros.push(mensagem);
const avisar = (mensagem) => avisos.push(mensagem);
const passar = (mensagem) => ok.push(mensagem);

// --- 1. manifest ---------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(ler('manifest.json'));
  passar('manifest.json é um JSON válido');
} catch (error) {
  falhar(`manifest.json inválido: ${error.message}`);
  process.exit(1);
}

const arquivosReferenciados = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
].filter(Boolean);

for (const arquivo of new Set(arquivosReferenciados)) {
  if (existsSync(join(raiz, arquivo))) passar(`arquivo do manifesto existe: ${arquivo}`);
  else falhar(`arquivo declarado no manifesto não existe: ${arquivo}`);
}

if (manifest.manifest_version !== 3) falhar('manifest_version deve ser 3');
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version || '')) {
  falhar(`version "${manifest.version}" fora do formato aceito pela Chrome Web Store`);
}
if (manifest.default_locale && !existsSync(join(raiz, '_locales', manifest.default_locale))) {
  falhar(`default_locale "${manifest.default_locale}" declarado sem a pasta _locales correspondente`);
}

// --- 2. sintaxe ----------------------------------------------------
// A lista sai do próprio manifesto, para que um script novo nunca escape.
const scripts = [
  { arquivo: manifest.background.service_worker, modulo: manifest.background?.type === 'module' },
  ...(manifest.content_scripts || []).flatMap((cs) => (cs.js || []).map((arquivo) => ({ arquivo, modulo: false }))),
  { arquivo: 'popup.js', modulo: false },
];

for (const { arquivo, modulo } of scripts) {
  try {
    execFileSync(
      process.execPath,
      modulo ? ['--input-type=module', '--check'] : ['--check', join(raiz, arquivo)],
      modulo ? { input: ler(arquivo), stdio: ['pipe', 'pipe', 'pipe'] } : { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    passar(`sintaxe ok: ${arquivo}${modulo ? ' (módulo)' : ''}`);
  } catch (error) {
    falhar(`erro de sintaxe em ${arquivo}: ${String(error.stderr || error.message).trim()}`);
  }
}

// --- 2b. regras do mundo MAIN --------------------------------------
// Scripts injetados no mundo da página não têm acesso a chrome.* e conversam
// apenas por postMessage — que precisa ser endereçado, nunca '*'.
for (const cs of manifest.content_scripts || []) {
  if (cs.world !== 'MAIN') continue;
  for (const arquivo of cs.js || []) {
    const fonte = ler(arquivo);

    if (/\bchrome\.\w+/.test(fonte)) {
      falhar(`${arquivo} roda no mundo MAIN e usa chrome.* — indisponível nesse contexto`);
    } else {
      passar(`${arquivo} (mundo MAIN) não usa chrome.*`);
    }

    if (/postMessage\([^)]*,\s*['"]\*['"]\s*\)/.test(fonte)) {
      falhar(`${arquivo} usa postMessage com destino '*' — vaza dados para a página`);
    } else {
      passar(`${arquivo} endereça o postMessage a uma origem específica`);
    }

    if (cs.run_at !== 'document_start') {
      avisar(`${arquivo} intercepta chamadas mas roda em ${cs.run_at} — pode perder as primeiras`);
    } else {
      passar(`${arquivo} roda em document_start`);
    }
  }
}

// O content script isolado precisa validar a origem das mensagens que recebe.
const conteudoContent = ler('content.js');
if (/addEventListener\('message'/.test(conteudoContent)) {
  if (/evento\.origin !== window\.location\.origin|event\.origin !== window\.location\.origin/.test(conteudoContent)) {
    passar('content.js valida a origem das mensagens recebidas');
  } else {
    falhar('content.js escuta "message" sem validar event.origin');
  }
}

// --- 3. mensagens content/popup -> background ----------------------
const background = ler('background.js');
const inicioHandlers = background.indexOf('const handlers = {');
const fimHandlers = background.indexOf('\n};', inicioHandlers);
const blocoHandlers = background.slice(inicioHandlers, fimHandlers);
const handlers = new Set([...blocoHandlers.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]));

if (!handlers.size) falhar('não foi possível localizar o mapa de handlers em background.js');
else passar(`background.js expõe ${handlers.size} handlers`);

/**
 * Coleta os tipos de mensagem realmente enviados. Só olha dentro de
 * `send({ type: … })` para não confundir com `attrs: { type: 'number' }`, e
 * descarta literais que fazem parte de uma comparação (`x === 'ml' ? …`).
 */
function tiposEnviados(fonte) {
  const tipos = new Set();
  for (const match of fonte.matchAll(/send\(\s*\{\s*type:\s*([^\n,]+)/g)) {
    const expressao = match[1].replace(/[=!]==?\s*'[^']*'/g, '');
    for (const literal of expressao.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)) tipos.add(literal[1]);
  }
  return tipos;
}

for (const arquivo of ['content.js', 'popup.js']) {
  const tipos = tiposEnviados(ler(arquivo));
  if (!tipos.size) avisar(`${arquivo}: nenhum tipo de mensagem literal encontrado`);
  for (const tipo of tipos) {
    if (handlers.has(tipo)) passar(`${arquivo} → handler "${tipo}" existe`);
    else falhar(`${arquivo} envia a mensagem "${tipo}", que não tem handler no background.js`);
  }
}

// --- 4. ids usados pelo popup.js existem no popup.html -------------
const popupHtml = ler('popup.html');
const popupJs = ler('popup.js');
const idsHtml = new Set([...popupHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const idsUsados = new Set([...popupJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

for (const id of idsUsados) {
  if (idsHtml.has(id)) passar(`popup.html tem #${id}`);
  else falhar(`popup.js usa #${id}, ausente em popup.html`);
}

const seletoresJs = [...popupJs.matchAll(/querySelectorAll\('\.([a-z-]+)'\)/g)].map((m) => m[1]);
for (const classe of new Set(seletoresJs)) {
  if (popupHtml.includes(`class="${classe}`) || popupHtml.includes(`${classe} `) || popupHtml.includes(`"${classe}"`)) {
    passar(`popup.html tem elementos .${classe}`);
  } else {
    avisar(`popup.js consulta .${classe}, que não aparece em popup.html`);
  }
}

// --- 5. superfície de XSS ------------------------------------------
for (const arquivo of ['content.js', 'popup.js']) {
  const fonte = ler(arquivo);
  const ocorrencias = [...fonte.matchAll(/\.(inner|outer)HTML\s*=/g)];
  if (ocorrencias.length) falhar(`${arquivo} escreve em innerHTML/outerHTML (${ocorrencias.length}x)`);
  else passar(`${arquivo} não escreve HTML como string`);
}

// --- 6. CSS sem fontes remotas -------------------------------------
for (const arquivo of ['style.css', 'popup.css']) {
  const fonte = ler(arquivo);
  if (/@import\s+url\(['"]?https?:/.test(fonte)) {
    falhar(`${arquivo} importa uma folha de estilo remota — a CSP bloqueia`);
  } else {
    passar(`${arquivo} não depende de recursos remotos`);
  }
}

if (/<style/.test(popupHtml)) falhar('popup.html tem <style> embutido — a CSP style-src \'self\' bloqueia');
if (/\sstyle="/.test(popupHtml)) falhar("popup.html tem style=\"…\" inline — a CSP style-src 'self' bloqueia");
if (/\son[a-z]+="/.test(popupHtml)) falhar('popup.html tem handler inline (onclick=…), bloqueado pela CSP do MV3');

// A CSP declara connect-src: todo host consultado pelo service worker precisa constar.
const csp = manifest.content_security_policy?.extension_pages || '';
const connectSrc = csp.match(/connect-src([^;]*)/)?.[1] || '';
for (const host of new Set([...background.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]))) {
  if (host.includes('mercadolivre.com.br') || host.includes('developers')) continue; // auth roda fora do fetch
  if (connectSrc.includes(host)) passar(`connect-src cobre ${host}`);
  else falhar(`background.js consulta ${host}, ausente de connect-src na CSP`);
}

// --- Relatório ------------------------------------------------------
console.log(`\n✔ ${ok.length} verificações passaram`);
for (const aviso of avisos) console.log(`⚠ ${aviso}`);
for (const erro of erros) console.log(`✖ ${erro}`);

if (erros.length) {
  console.log(`\n${erros.length} problema(s) encontrado(s).\n`);
  process.exit(1);
}
console.log(`\nExtensão validada${avisos.length ? ` com ${avisos.length} aviso(s)` : ' sem problemas'}.\n`);
