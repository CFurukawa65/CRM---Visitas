/* app.js — CRM Visitas · Copasul (PWA, funciona sem sinal)
 * Fluxo: lista de negócios (carteira do escritório) → ficha só de leitura → "Atualizar negócio" (ou "Novo negócio") → GPS → grava por voz
 * cada campo → salva → envia quando houver sinal. O aparelho se atualiza sozinho com o escritório (status, textos, carteira).
 * Modo "lançamento do escritório" (Config): sem GPS; informa o vendedor e a data real da visita. */
(function () {
  'use strict';
  const L = window.Logic;
  const $ = (s, r) => (r || document).querySelector(s);

  /* ---------- helper de DOM ---------- */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    Array.prototype.slice.call(arguments, 2).flat(Infinity).forEach((f) => {
      if (f === null || f === undefined || f === false) return;
      el.append(f.nodeType ? f : document.createTextNode(String(f)));
    });
    return el;
  }

  /* ---------- estado ---------- */
  const S = {
    vendedor: '', vendedores: [], endpoint: '', token: '', modoEscritorio: false,
    tela: 'lista', fichaId: '', draft: null, registros: [],
    srv: { negocios: [], visitas: [], meta: null }, lista: [],
    filtro: { busca: '', municipio: '', etapa: '', vencidas: false },
    sync: { rodando: false, erro: '', aviso: '', ultimaTentativa: 0 },
    histAberto: '',
    gps: { status: 'idle', best: null, watchId: null, timer: null },
    rec: null, enviando: false, instalar: null, opcionalAberto: false,
  };
  const novoDraft = () => ({
    negocioSel: '', valores: {}, texto: { cliente: '', fazenda: '', municipio: '', telefone: '' }, audios: {}, pdf: null,
    lancandoEm: '', dataVisita: '', horaVisita: '', presenca: 'local', telefoneInicial: '',
  });
  const temOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* ---------- negócios do aparelho = carteira do escritório + o que foi feito aqui e ainda não voltou ---------- */
  const negocioPorId = (id) => S.lista.find((n) => n.id === id) || null;
  const srvVisitasPorId = () => { const m = {}; S.srv.visitas.forEach((v) => { m[v.id] = v; }); return m; };
  function recomputar() { S.lista = L.unirNegocios(S.registros, S.srv.negocios, S.srv.visitas); }

  /* ---------- configuração local ---------- */
  const CFG_KEY = 'crmcopasul.cfg';
  function lerCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } }
  function gravarCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ vendedor: S.vendedor, endpoint: S.endpoint, token: S.token, vendedores: S.vendedores, modoEscritorio: S.modoEscritorio })); } catch (e) { /* sem storage */ }
  }
  const b64uEnc = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64uDec = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  function aplicarLinkConfig() {
    const m = location.hash.match(/#cfg=([^&]+)/);
    if (!m) return false;
    try {
      const o = JSON.parse(b64uDec(m[1]));
      if (o.endpoint) S.endpoint = o.endpoint;
      if (o.token) S.token = o.token;
      if (o.vendedor) S.vendedor = o.vendedor;
      if (Array.isArray(o.vendedores)) S.vendedores = o.vendedores;
      gravarCfg();
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) { return false; }
  }

  /* ---------- banco local (IndexedDB) ----------
   * v1: registros (visitas feitas aqui), arquivos (áudios/PDF), rascunho.
   * v2: negocios + visitas_srv + meta = a carteira que veio do escritório (substituída inteira a cada atualização). */
  const DB = {
    _db: null,
    abrir() {
      if (this._db) return this._db;
      this._db = new Promise((res, rej) => {
        const r = indexedDB.open('crm-copasul', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('registros')) db.createObjectStore('registros', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('arquivos')) db.createObjectStore('arquivos', { keyPath: 'chave' }).createIndex('registro', 'registroId');
          if (!db.objectStoreNames.contains('rascunho')) db.createObjectStore('rascunho');
          if (!db.objectStoreNames.contains('negocios')) db.createObjectStore('negocios', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('visitas_srv')) db.createObjectStore('visitas_srv', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this._db;
    },
    async _tx(stores, modo, fn) {
      const db = await this.abrir();
      return new Promise((res, rej) => {
        const t = db.transaction(stores, modo);
        let out;
        try { out = fn(t); } catch (e) { rej(e); return; }
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('transação cancelada'));
      });
    },
    put(store, val, key) { return this._tx(store, 'readwrite', (t) => (key !== undefined ? t.objectStore(store).put(val, key) : t.objectStore(store).put(val))); },
    get(store, key) { return this._tx(store, 'readonly', (t) => t.objectStore(store).get(key)); },
    todos(store) { return this._tx(store, 'readonly', (t) => t.objectStore(store).getAll()); },
    todosRegistros() { return this.todos('registros'); },
    arquivosDoRegistro(id) { return this._tx('arquivos', 'readonly', (t) => t.objectStore('arquivos').index('registro').getAll(id)); },
    salvarRegistro(reg, arqs) {
      return this._tx(['registros', 'arquivos'], 'readwrite', (t) => {
        t.objectStore('registros').put(reg);
        arqs.forEach((a) => t.objectStore('arquivos').put(a));
      });
    },
    /** Apaga só os áudios/PDF do registro (o registro e os textos ficam). */
    limparArquivos(id) {
      return this._tx('arquivos', 'readwrite', (t) => {
        const rq = t.objectStore('arquivos').index('registro').openKeyCursor(IDBKeyRange.only(id));
        rq.onsuccess = () => { const c = rq.result; if (c) { t.objectStore('arquivos').delete(c.primaryKey); c.continue(); } };
      });
    },
    excluirRegistro(id) {
      return this._tx(['registros', 'arquivos'], 'readwrite', (t) => {
        t.objectStore('registros').delete(id);
        const rq = t.objectStore('arquivos').index('registro').openKeyCursor(IDBKeyRange.only(id));
        rq.onsuccess = () => { const c = rq.result; if (c) { t.objectStore('arquivos').delete(c.primaryKey); c.continue(); } };
      });
    },
    /** Troca a carteira inteira de uma vez (tudo ou nada). */
    salvarCarteira(negocios, visitas, meta) {
      return this._tx(['negocios', 'visitas_srv', 'meta'], 'readwrite', (t) => {
        const n = t.objectStore('negocios'), v = t.objectStore('visitas_srv');
        n.clear(); v.clear();
        negocios.forEach((x) => n.put(x));
        visitas.forEach((x) => v.put(x));
        t.objectStore('meta').put(meta, 'sync');
      });
    },
    limparCarteira() {
      return this._tx(['negocios', 'visitas_srv', 'meta'], 'readwrite', (t) => { t.objectStore('negocios').clear(); t.objectStore('visitas_srv').clear(); t.objectStore('meta').clear(); });
    },
  };

  /* ---------- avisos ---------- */
  let tToast;
  function toast(msg, tipo) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (tipo === 'erro' ? ' erro' : '');
    t.hidden = false;
    clearTimeout(tToast);
    tToast = setTimeout(() => { t.hidden = true; }, tipo === 'erro' ? 5500 : 3000);
  }
  function modal(conteudo) {
    const m = $('#modal');
    m.replaceChildren(h('div', { class: 'caixa' }, conteudo));
    m.hidden = false;
  }
  const fecharModal = () => { $('#modal').hidden = true; };

  /* ---------- GPS ---------- */
  function pararGPS() {
    if (S.gps.watchId !== null) { try { navigator.geolocation.clearWatch(S.gps.watchId); } catch (e) { /* */ } S.gps.watchId = null; }
    clearTimeout(S.gps.timer);
  }
  function finalizarGPS() {
    pararGPS();
    S.gps.status = S.gps.best ? (S.gps.best.acc <= 50 ? 'ok' : 'fraco') : 'sem_sinal';
    renderGps();
  }
  function iniciarGPS() {
    pararGPS();
    if (S.modoEscritorio || S.draft.presenca === 'distancia') return; // lançamento do escritório e visita à distância não marcam ponto
    if (!('geolocation' in navigator)) { S.gps.status = 'indisponivel'; renderGps(); return; }
    S.gps.status = 'buscando';
    S.gps.best = null;
    renderGps();
    S.gps.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        if (!S.gps.best || c.accuracy < S.gps.best.acc) S.gps.best = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, ts: pos.timestamp || Date.now() };
        if (c.accuracy <= 15) finalizarGPS(); else renderGps();
      },
      (err) => {
        if (err.code === 1) { pararGPS(); S.gps.status = 'negado'; renderGps(); }
        else finalizarGPS();
      },
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
    );
    S.gps.timer = setTimeout(finalizarGPS, 25000);
  }
  function renderGps() {
    const c = $('#gps-corpo');
    if (!c) return;
    const g = S.gps, b = g.best;
    const rot = { idle: ['', ''], buscando: ['atencao', 'Buscando satélites…'], ok: ['ok', 'Ponto marcado'], fraco: ['atencao', 'Precisão baixa'],
      negado: ['erro', 'Localização bloqueada'], sem_sinal: ['erro', 'Sem sinal de GPS'], indisponivel: ['erro', 'GPS indisponível'] }[g.status] || ['', ''];
    const detalhe = b
      ? 'Precisão ±' + Math.round(b.acc) + ' m · ' + new Date(b.ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
      : g.status === 'negado' ? 'Libere a localização nas permissões do navegador para marcar o ponto.' : 'Vá para céu aberto e aguarde alguns segundos.';
    c.replaceChildren(
      h('div', { class: 'gps-linha' },
        h('span', { class: 'gps-coord', text: b ? b.lat.toFixed(6) + ', ' + b.lng.toFixed(6) : '—' }),
        h('span', { class: 'estado ' + rot[0], text: rot[1] })),
      h('div', { class: 'ajuda', text: detalhe }),
      h('div', { class: 'linha-limpar' }, h('button', { class: 'btn pequeno', type: 'button', onclick: iniciarGPS, text: 'Atualizar GPS' }))
    );
  }

  /* ---------- áudio ---------- */
  const urlCache = new WeakMap();
  function urlDe(blob) {
    if (!urlCache.has(blob)) urlCache.set(blob, URL.createObjectURL(blob));
    return urlCache.get(blob);
  }
  function liberarUrls() {
    Object.keys(S.draft.audios).forEach((k) => { const b = S.draft.audios[k].blob; if (urlCache.has(b)) { URL.revokeObjectURL(urlCache.get(b)); urlCache.delete(b); } });
  }

  async function alternarGravacao(def) {
    if (S.rec && S.rec.key === def.key) { await pararGravacao(); return; }
    if (S.rec) await pararGravacao();
    await iniciarGravacao(def);
  }
  async function iniciarGravacao(def) {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Este navegador não grava áudio.', 'erro'); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Microfone bloqueado. Libere nas permissões do navegador.' : 'Não consegui abrir o microfone.', 'erro');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    const partes = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) partes.push(e.data); };
    const rec = { key: def.key, def, mr, stream, partes, t0: Date.now(), mime: mr.mimeType || mime || 'audio/webm', timer: null, wake: null };
    rec.parado = new Promise((res) => { mr.onstop = () => res(); });
    S.rec = rec;
    mr.start(1000);
    try { if (navigator.wakeLock) rec.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* opcional */ }
    if (navigator.vibrate) navigator.vibrate(40);
    rec.timer = setInterval(() => {
      const s = (Date.now() - rec.t0) / 1000;
      const el = document.getElementById('info-' + def.key);
      if (el) el.textContent = '● gravando ' + L.fmtDur(s);
      if (s >= def.max) pararGravacao();
    }, 250);
    renderVisita();
  }
  async function pararGravacao() {
    const rec = S.rec;
    if (!rec) return;
    S.rec = null;
    clearInterval(rec.timer);
    const dur = (Date.now() - rec.t0) / 1000;
    if (rec.mr.state !== 'inactive') { try { rec.mr.stop(); } catch (e) { /* */ } await rec.parado; }
    rec.stream.getTracks().forEach((t) => t.stop());
    try { if (rec.wake) rec.wake.release(); } catch (e) { /* */ }
    if (navigator.vibrate) navigator.vibrate(20);
    const blob = new Blob(rec.partes, { type: rec.mime });
    if (blob.size < 300 || dur < 0.6) { toast('Gravação muito curta. Tente de novo.', 'erro'); renderVisita(); return; }
    S.draft.audios[rec.key] = { blob, mime: rec.mime, dur };
    agendarRascunho();
    renderVisita();
  }
  function apagarAudio(key) {
    const a = S.draft.audios[key];
    if (a && urlCache.has(a.blob)) { URL.revokeObjectURL(urlCache.get(a.blob)); urlCache.delete(a.blob); }
    delete S.draft.audios[key];
    agendarRascunho();
    renderVisita();
  }

  /* ---------- rascunho (não perde nada se o app fechar) ---------- */
  let tRasc;
  function agendarRascunho() {
    clearTimeout(tRasc);
    tRasc = setTimeout(() => { DB.put('rascunho', S.draft, 'atual').catch(() => {}); }, 350);
  }
  const draftTemConteudo = () => {
    const d = S.draft;
    return Object.keys(d.valores).length || Object.keys(d.audios).length || d.pdf || d.texto.cliente || d.texto.fazenda || d.texto.municipio || (d.texto.telefone || '') !== (d.telefoneInicial || '');
  };

  /* ---------- valores atuais (último estado conhecido do negócio) ---------- */
  const atualDoNegocio = (id) => { const n = negocioPorId(id); return n ? n.campos : {}; };
  const negocioAtualMapa = () => (S.draft.negocioSel && S.draft.negocioSel !== 'NOVO' ? atualDoNegocio(S.draft.negocioSel) : {});
  function valoresEfetivos() {
    const ef = Object.assign({}, negocioAtualMapa());
    Object.keys(S.draft.valores).forEach((k) => { const v = S.draft.valores[k]; if (v === null) delete ef[k]; else ef[k] = v; });
    return ef;
  }

  function alternarValor(key, v) {
    if (S.draft.valores[key] === v) delete S.draft.valores[key];
    else S.draft.valores[key] = v;
    if (key === 'etapa') delete S.draft.valores.motivo;
    agendarRascunho();
    renderVisita();
  }
  function definirValor(key, v) { S.draft.valores[key] = v; agendarRascunho(); renderVisita(); }
  function desfazerValor(key) { delete S.draft.valores[key]; if (key === 'etapa') delete S.draft.valores.motivo; agendarRascunho(); renderVisita(); }

  /* ---------- componentes de campo ---------- */
  function envolver(def, filhos) {
    return h('div', { class: 'campo', 'data-campo': def.key },
      h('div', { class: 'rotulo' }, h('span', null, def.rotulo), def.obrigatorio ? h('span', { class: 'obrig' }, 'obrigatório') : null),
      def.tipo === 'voz' && def.exemplo ? h('p', { class: 'exemplo' }, def.exemplo) : null,
      def.dica ? h('p', { class: 'exemplo' }, def.dica) : null,
      filhos);
  }

  function textoAtual(def, v) {
    if (v === undefined || v === null) return '';
    if (def.tipo === 'estrelas') return '★ ' + v;
    if (def.tipo === 'sim_nao') return v === 'sim' ? 'Sim' : 'Não';
    if (def.tipo === 'mes') { const p = String(v).split('-'); return p[1] + '/' + p[0]; }
    if (def.tipo === 'data') { const p = String(v).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
    if (def.tipo === 'multi') return (v || []).join(', ');
    const o = L.opcoesDoCampo(def, valoresEfetivos()).find((x) => x.v === v);
    return o ? o.t : String(v);
  }

  function notaAtual(def, atualV) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado ? S.draft.valores[def.key] : undefined;
    const linhas = [];
    if (!tocado && atualV !== undefined) linhas.push(h('div', { class: 'atual' }, 'Atual: ' + textoAtual(def, atualV) + ' (mantido se você não tocar)'));
    if (tocado && sel === null) linhas.push(h('div', { class: 'atual' }, 'O valor será apagado.'));
    const acoes = [];
    if (tocado) acoes.push(h('button', { class: 'link', type: 'button', onclick: () => desfazerValor(def.key) }, 'Desfazer alteração'));
    if (atualV !== undefined && sel !== null) acoes.push(h('button', { class: 'link', type: 'button', onclick: () => definirValor(def.key, null) }, 'Apagar valor'));
    return h('div', { class: 'linha-limpar' }, linhas, acoes.map((a, i) => (i ? [' · ', a] : a)));
  }

  function campoOpcoes(def, ef, atual) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado ? S.draft.valores[def.key] : undefined;
    const atualV = atual[def.key];
    const opcoes = L.opcoesDoCampo(def, ef).slice();
    // valor vindo do CRM antigo que não está na lista do app (ex.: outra etapa): aparece como chip extra para poder ser mantido
    if (atualV !== undefined && atualV !== null && atualV !== '' && !opcoes.some((o) => o.v === atualV)) opcoes.push({ v: atualV, t: String(atualV) + ' (atual)' });
    const chips = opcoes.map((o) =>
      h('button', { type: 'button', class: 'chip' + (sel === o.v ? ' sel' : '') + (!tocado && atualV === o.v ? ' atualmarca' : ''), onclick: () => alternarValor(def.key, o.v) }, o.t));
    return envolver(def, [h('div', { class: 'chips' }, chips), notaAtual(def, atualV)]);
  }
  function campoSimNao(def, ef, atual) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado ? S.draft.valores[def.key] : undefined;
    const atualV = atual[def.key];
    const chips = [['sim', 'Sim'], ['nao', 'Não']].map(([v, t]) =>
      h('button', { type: 'button', class: 'chip' + (sel === v ? ' sel' : '') + (!tocado && atualV === v ? ' atualmarca' : ''), onclick: () => alternarValor(def.key, v) }, t));
    return envolver(def, [h('div', { class: 'chips' }, chips), notaAtual(def, atualV)]);
  }
  function campoMulti(def, ef, atual) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado && Array.isArray(S.draft.valores[def.key]) ? S.draft.valores[def.key] : [];
    const atualV = atual[def.key];
    const chips = def.opcoes.map((o) =>
      h('button', {
        type: 'button', class: 'chip' + (sel.indexOf(o.v) >= 0 ? ' sel' : '') + (!tocado && Array.isArray(atualV) && atualV.indexOf(o.v) >= 0 ? ' atualmarca' : ''),
        onclick: () => {
          const base = tocado && Array.isArray(S.draft.valores[def.key]) ? S.draft.valores[def.key].slice() : (Array.isArray(atualV) ? atualV.slice() : []);
          const i = base.indexOf(o.v);
          if (i >= 0) base.splice(i, 1); else base.push(o.v);
          if (base.length) S.draft.valores[def.key] = base; else delete S.draft.valores[def.key];
          agendarRascunho(); renderVisita();
        },
      }, o.t));
    return envolver(def, [h('div', { class: 'chips' }, chips), notaAtual(def, atualV)]);
  }
  function campoEstrelas(def, ef, atual) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado ? S.draft.valores[def.key] : undefined;
    const atualV = atual[def.key];
    const estrelas = [1, 2, 3, 4, 5].map((n) =>
      h('button', { type: 'button', 'aria-label': n + ' de 5', class: 'estrela' + (sel >= n ? ' on' : '') + (!tocado && atualV >= n ? ' atualmarca' : ''), onclick: () => alternarValor(def.key, n) }, '★'));
    return envolver(def, [h('div', { class: 'estrelas' }, estrelas), notaAtual(def, atualV)]);
  }
  function campoDataMes(def, ef, atual) {
    const tocado = temOwn(S.draft.valores, def.key);
    const sel = tocado ? S.draft.valores[def.key] : '';
    const entrada = h('input', {
      type: def.tipo === 'mes' ? 'month' : 'date', value: sel || '', 'aria-label': def.rotulo,
      onchange: (e) => { if (e.target.value) definirValor(def.key, e.target.value); else desfazerValor(def.key); },
    });
    return envolver(def, [entrada, notaAtual(def, atual[def.key])]);
  }
  function campoPdf(def) {
    const p = S.draft.pdf;
    const entrada = h('input', { type: 'file', accept: 'application/pdf,.pdf', id: 'in-pdf', onchange: onPdf });
    return envolver(def, [
      h('div', { class: 'arquivo-linha' },
        h('button', { class: 'btn', type: 'button', onclick: () => entrada.click() }, p ? 'Trocar PDF' : '📎 Anexar PDF'),
        entrada,
        p ? h('span', { class: 'voz-info' }, p.name + ' · ' + L.fmtBytes(p.size)) : null,
        p ? h('button', { class: 'btn pequeno perigo', type: 'button', onclick: () => { S.draft.pdf = null; agendarRascunho(); renderVisita(); } }, 'Remover') : null),
      h('div', { class: 'ajuda' }, 'Use o nome padrão "Cliente - Fazenda - vNN - data". Os dados do projeto (pivôs, lances, hectares, valores) são lidos no escritório.'),
    ]);
  }
  function onPdf(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Escolha um arquivo PDF.', 'erro'); return; }
    if (f.size > 8 * 1048576) { toast('PDF maior que 8 MB. Reduza o arquivo antes de anexar.', 'erro'); return; }
    S.draft.pdf = { blob: f, name: f.name, size: f.size };
    agendarRascunho();
    renderVisita();
  }

  function widgetVoz(def) {
    const a = S.draft.audios[def.key];
    const gravando = S.rec && S.rec.key === def.key;
    const caixa = h('div', { class: 'voz' });
    caixa.append(h('button', {
      id: 'mic-' + def.key, type: 'button', 'aria-label': def.rotulo + ': gravar',
      class: 'mic' + (gravando ? ' gravando' : a ? ' feito' : ''), onclick: () => alternarGravacao(def),
    }, gravando ? '⏹ Parar' : a ? '🎤 Regravar' : '🎤 Gravar'));
    if (gravando) caixa.append(h('span', { class: 'voz-info', id: 'info-' + def.key }, '● gravando 0:00'));
    else if (a) {
      caixa.append(h('audio', { controls: true, src: urlDe(a.blob), preload: 'metadata' }),
        h('span', { class: 'voz-info' }, L.fmtDur(a.dur)),
        h('button', { class: 'btn pequeno perigo', type: 'button', onclick: () => apagarAudio(def.key) }, 'Apagar'));
    } else caixa.append(h('span', { class: 'voz-info', id: 'info-' + def.key }, 'até ' + L.fmtDur(def.max)));
    return caixa;
  }
  /** Campo de voz: mostra o texto que o escritório transcreveu da última vez ("Atual") e o mantém se não for regravado. */
  function campoVoz(def, atual) {
    const av = atual ? atual[def.key] : undefined;
    const nota = av !== undefined && av !== null && av !== '' && !S.draft.audios[def.key] ? h('div', { class: 'atual', 'data-atual': def.key }, 'Atual: ' + L.textoCampo(def, av) + ' (mantido se você não gravar)') : null;
    return envolver(def, [widgetVoz(def), nota]);
  }
  function campoTextoVoz(def) {
    return envolver(def, h('div', { class: 'texto-voz' },
      h('input', { type: 'text', placeholder: def.exemplo, value: S.draft.texto[def.key], autocomplete: 'off', 'aria-label': def.rotulo,
        oninput: (e) => { S.draft.texto[def.key] = e.target.value; agendarRascunho(); } }),
      widgetVoz(def)));
  }
  /** Telefone: só digitado (teclado numérico), opcional. */
  function campoTelefone(def) {
    return envolver(def, h('input', { type: 'tel', inputmode: 'tel', id: 'in-' + def.key, placeholder: def.exemplo, value: S.draft.texto[def.key] || '', autocomplete: 'off', 'aria-label': def.rotulo,
      oninput: (e) => { S.draft.texto[def.key] = e.target.value; agendarRascunho(); } }));
  }

  function renderCampo(def, ef, atual) {
    switch (def.tipo) {
      case 'voz': return campoVoz(def, atual);
      case 'texto_voz': return campoTextoVoz(def);
      case 'telefone': return campoTelefone(def);
      case 'opcoes': return campoOpcoes(def, ef, atual);
      case 'sim_nao': return campoSimNao(def, ef, atual);
      case 'multi': return campoMulti(def, ef, atual);
      case 'estrelas': return campoEstrelas(def, ef, atual);
      case 'mes': case 'data': return campoDataMes(def, ef, atual);
      case 'arquivo': return campoPdf(def);
      default: return null;
    }
  }

  /* ---------- tela: Visita (novo negócio ou "Atualizar negócio") ---------- */
  function iniciarVisita(id) {
    const outro = !!S.draft.negocioSel && S.draft.negocioSel !== id;
    if (outro && draftTemConteudo() && !confirm('Há uma visita em andamento em outro negócio. Descartar e começar esta?')) return;
    if (S.draft.negocioSel !== id) {
      const { lancandoEm, dataVisita, horaVisita } = S.draft;
      liberarUrls();
      S.draft = novoDraft();
      Object.assign(S.draft, { lancandoEm, dataVisita, horaVisita }); // no lançamento do escritório estes valem para a sequência
      S.draft.negocioSel = id;
      const n = id === 'NOVO' ? null : negocioPorId(id);
      if (n && n.telefone) { S.draft.texto.telefone = n.telefone; S.draft.telefoneInicial = n.telefone; }
      agendarRascunho();
    }
    mostrarTela('visita');
    iniciarGPS();
  }
  async function sairDaVisita() {
    if (S.rec) await pararGravacao();
    pararGPS();
    if (S.draft.negocioSel && S.draft.negocioSel !== 'NOVO' && negocioPorId(S.draft.negocioSel)) { S.fichaId = S.draft.negocioSel; mostrarTela('ficha'); } else mostrarTela('lista');
  }
  async function descartarVisita() {
    if (draftTemConteudo() && !confirm('Descartar o que já foi preenchido nesta visita?')) return;
    if (S.rec) await pararGravacao();
    liberarUrls(); pararGPS();
    const { lancandoEm } = S.draft;
    S.draft = Object.assign(novoDraft(), lancandoEm ? { lancandoEm } : {});
    agendarRascunho();
    mostrarTela('lista');
  }
  function definirPresenca(v) {
    S.draft.presenca = v;
    agendarRascunho();
    renderVisita();
    if (v === 'distancia') pararGPS(); else iniciarGPS();
  }

  function cardTopoVisita() {
    return h('div', { class: 'barra-voltar' },
      h('button', { class: 'btn pequeno', type: 'button', id: 'btn-voltar', onclick: sairDaVisita }, '← Voltar'),
      h('button', { class: 'link', type: 'button', id: 'btn-descartar', onclick: descartarVisita }, 'Descartar visita'));
  }

  /** Onde a visita aconteceu: na propriedade (grava GPS e pode corrigir o ponto do negócio) ou à distância (sem GPS; não move o ponto). */
  function cardLocal() {
    const pres = S.draft.presenca || 'local';
    const chips = h('div', { class: 'chips' }, [['local', 'Na propriedade (grava GPS)'], ['distancia', 'À distância (sem GPS)']].map(([v, t]) =>
      h('button', { type: 'button', id: 'pres-' + v, class: 'chip' + (pres === v ? ' sel' : ''), onclick: () => definirPresenca(v) }, t)));
    return h('div', { class: 'card' }, h('h2', null, 'Local do registro'), chips,
      pres === 'local' ? h('div', { id: 'gps-corpo' }) : h('p', { class: 'ajuda' }, 'Sem GPS: o ponto do negócio não muda.'));
  }

  function cardNegocio() {
    const novo = S.draft.negocioSel === 'NOVO';
    const n = novo ? null : negocioPorId(S.draft.negocioSel);
    const filhos = [h('h2', null, novo ? 'Novo negócio' : 'Atualizar negócio')];
    if (novo) {
      filhos.push(h('p', { class: 'ajuda' }, 'Digite ou grave o nome. Se gravar, o escritório completa a identificação.'));
      L.CAMPOS.filter((c) => c.grupo === 'ident').forEach((def) => filhos.push(renderCampo(def, {}, {})));
    } else if (n) {
      filhos.push(h('div', { class: 'ident-fixa', id: 'ident-fixa' }, L.rotuloNegocio(n)),
        h('p', { class: 'ajuda' }, 'Cliente, fazenda e município só o escritório altera. O telefone você pode corrigir.'),
        renderCampo(L.campoPorChave('telefone'), {}, {}));
    } else filhos.push(h('p', { class: 'ajuda' }, 'Negócio não encontrado neste aparelho.'));
    return h('div', { class: 'card' }, filhos);
  }

  function cardRelatorio(ef, atual) {
    const defs = L.CAMPOS.filter((c) => c.grupo === 'relatorio' && L.campoVisivel(c, ef));
    return h('div', { class: 'card' }, h('h2', null, 'Relatório da visita'), defs.map((d) => renderCampo(d, ef, atual)));
  }
  function cardOpcionais(ef, atual) {
    const det = h('details', { class: 'card' }, h('summary', null, 'Opcionais'),
      L.CAMPOS.filter((c) => c.grupo === 'opcional').map((d) => renderCampo(d, ef, atual)));
    if (S.opcionalAberto) det.setAttribute('open', '');
    det.addEventListener('toggle', () => { S.opcionalAberto = det.open; });
    return det;
  }

  /** Lançamento do escritório: em nome de quem, e quando a visita aconteceu de verdade. */
  function cardLancamento() {
    const lista = S.vendedores.length ? h('datalist', { id: 'lista-vendedores' }, S.vendedores.map((v) => h('option', { value: v }))) : null;
    const em = h('input', { type: 'text', id: 'in-lancando-em', list: lista ? 'lista-vendedores' : null, value: S.draft.lancandoEm, placeholder: 'Nome do vendedor', autocomplete: 'off', 'aria-label': 'Lançando em nome de',
      oninput: (e) => { S.draft.lancandoEm = e.target.value; agendarRascunho(); } });
    const data = h('input', { type: 'date', id: 'in-data-visita', value: S.draft.dataVisita, 'aria-label': 'Data da visita',
      onchange: (e) => { S.draft.dataVisita = e.target.value; agendarRascunho(); } });
    const hora = h('input', { type: 'time', id: 'in-hora-visita', value: S.draft.horaVisita, 'aria-label': 'Hora da visita (opcional)',
      onchange: (e) => { S.draft.horaVisita = e.target.value; agendarRascunho(); } });
    return h('div', { class: 'card lancamento' }, h('h2', null, 'Lançamento do escritório'),
      h('p', { class: 'ajuda' }, 'Sem GPS. A visita entra com a data real informada abaixo e já fica liberada.'),
      h('div', { class: 'campo', 'data-campo': 'lancando_em' }, h('div', { class: 'rotulo' }, h('span', null, 'Lançando em nome de'), h('span', { class: 'obrig' }, 'obrigatório')), em, lista),
      h('div', { class: 'campo', 'data-campo': 'data_visita' }, h('div', { class: 'rotulo' }, h('span', null, 'Data da visita'), h('span', { class: 'obrig' }, 'obrigatório')), data),
      h('div', { class: 'campo', 'data-campo': 'hora_visita' }, h('div', { class: 'rotulo' }, h('span', null, 'Hora (opcional)')), hora));
  }

  function renderVisita() {
    const raiz = $('#view-visita');
    if (!S.draft.negocioSel) { raiz.replaceChildren(h('div', { class: 'vazio' }, 'Escolha um negócio na aba Negócios.')); return; }
    const ef = valoresEfetivos();
    const atual = negocioAtualMapa();
    raiz.replaceChildren(cardTopoVisita(), S.modoEscritorio ? cardLancamento() : cardLocal(), cardNegocio(), cardRelatorio(ef, atual), cardOpcionais(ef, atual));
    renderGps();
  }

  /* ---------- salvar ---------- */
  function mostrarErros(erros) {
    modal([h('h3', null, 'Falta preencher'), h('ul', { class: 'erros' }, erros.map((e) => h('li', null, e))),
      h('button', { class: 'btn primario', type: 'button', onclick: fecharModal }, 'Entendi')]);
  }

  async function salvar() {
    if (S.rec) await pararGravacao();
    const escritorio = S.modoEscritorio;
    const erros = L.validarRegistro(Object.assign({}, S.draft, { modo: escritorio ? 'escritorio' : 'campo' }));
    if (erros.length) { mostrarErros(erros); return; }
    if (!escritorio && !S.vendedor) { pedirVendedor(); return; }
    const btn = $('#btn-salvar');
    btn.disabled = true;
    try {
      const agora = new Date();
      const vendedor = escritorio ? S.draft.lancandoEm.trim() : S.vendedor;
      const dh = escritorio ? L.dataHoraVisita(S.draft.dataVisita, S.draft.horaVisita) : null;
      const quando = dh ? dh.data : agora;
      const novo = S.draft.negocioSel === 'NOVO';
      const negocioId = novo ? L.gerarCodigoProvisorio(agora) : S.draft.negocioSel;
      const conhecido = novo ? null : negocioPorId(negocioId);
      if (!novo && !conhecido) throw new Error('negócio não encontrado neste aparelho');
      const tel = L.limparTelefone(S.draft.texto.telefone);
      const ident = novo
        ? { cliente: S.draft.texto.cliente.trim(), fazenda: S.draft.texto.fazenda.trim(), municipio: S.draft.texto.municipio.trim(), telefone: tel }
        : { cliente: conhecido.cliente, fazenda: conhecido.fazenda, municipio: conhecido.municipio, telefone: tel && tel !== (S.draft.telefoneInicial || '') ? tel : '' };
      const ef = valoresEfetivos();
      const visiveis = L.CAMPOS.filter((c) => (novo || c.grupo !== 'ident') && L.campoVisivel(c, ef));
      const id = L.gerarId();
      const arquivos = [];
      const audiosMeta = {};
      const porVoz = {};
      visiveis.forEach((def) => {
        const a = S.draft.audios[def.key];
        if (!a) return;
        const nome = (def.grupo === 'ident' ? 'ident_' : '') + def.key + '.' + L.extPorMime(a.mime);
        arquivos.push({ chave: id + '/' + nome, registroId: id, nome, mime: a.mime, blob: a.blob, bytes: a.blob.size });
        audiosMeta[def.key] = { arquivo: nome, dur: Math.round(a.dur * 10) / 10, mime: a.mime };
        if (def.grupo === 'ident') porVoz[def.key] = true;
      });
      let pdfMeta = null;
      if (S.draft.pdf) {
        arquivos.push({ chave: id + '/projeto.pdf', registroId: id, nome: 'projeto.pdf', mime: 'application/pdf', blob: S.draft.pdf.blob, bytes: S.draft.pdf.size });
        pdfMeta = { arquivo: 'projeto.pdf', nomeOriginal: S.draft.pdf.name, bytes: S.draft.pdf.size };
      }
      const campos = {};
      visiveis.forEach((def) => { if (def.grupo !== 'ident' && temOwn(S.draft.valores, def.key)) campos[def.key] = S.draft.valores[def.key]; });
      const aDistancia = !escritorio && S.draft.presenca === 'distancia';
      const b = escritorio || aDistancia ? null : S.gps.best; // à distância: sem GPS, para não mover o ponto do negócio
      const reg = {
        esquema: 1, id, versaoApp: L.APP_VERSAO,
        nomeRelatorio: L.nomeRelatorio({ vendedor, cliente: ident.cliente, fazenda: ident.fazenda, municipio: ident.municipio, data: quando }),
        vendedor, criadoEm: agora.toISOString(), negocioId, prospectNovo: novo,
        identificacao: { cliente: ident.cliente, fazenda: ident.fazenda, municipio: ident.municipio, telefone: ident.telefone, porVoz },
        gps: b ? { lat: b.lat, lng: b.lng, acuraciaM: Math.round(b.acc), capturadoEm: new Date(b.ts).toISOString() } : null,
        campos, audios: audiosMeta, pdf: pdfMeta,
        status: 'pendente', enviados: {}, tentativas: 0, ultimoErro: '', bytes: arquivos.reduce((s, a) => s + a.bytes, 0),
      };
      if (aDistancia) reg.presenca = 'distancia';
      if (escritorio) {
        reg.origem = 'escritorio';
        reg.lancadoPor = S.vendedor || 'Escritório';
        reg.dataVisita = dh.iso;
        reg.dataVisitaSemHora = dh.semHora;
      }
      await DB.salvarRegistro(reg, arquivos);
      S.registros.push(reg);
      recomputar();
      liberarUrls();
      pararGPS();
      const mantem = escritorio ? { lancandoEm: S.draft.lancandoEm } : {};
      S.draft = Object.assign(novoDraft(), mantem);
      await DB.put('rascunho', S.draft, 'atual');
      toast(escritorio ? 'Lançamento salvo ✓ — pendente de envio' : aDistancia ? 'Registro salvo (à distância, sem GPS) ✓ — pendente de envio' : b ? 'Registro salvo ✓ — pendente de envio' : 'Registro salvo SEM ponto GPS — pendente de envio');
      atualizarTopo();
      if (!novo) { S.fichaId = negocioId; mostrarTela('ficha'); } else mostrarTela('lista');
      enviarPendentes();
    } catch (e) {
      toast('Não consegui salvar: ' + (e && e.message ? e.message : e), 'erro');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- envio (só quando houver sinal; reenvio seguro) ---------- */
  function blobParaB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  async function postar(obj) {
    if (!S.endpoint) throw new Error('Endereço do recebedor não configurado (aba Config).');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const resp = await fetch(S.endpoint, { method: 'POST', body: JSON.stringify(Object.assign({}, obj, { token: S.token, vendedor: S.vendedor })), signal: ctrl.signal, redirect: 'follow' });
      const txt = await resp.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('Resposta inesperada do recebedor.'); }
      if (!j.ok) { const err = new Error(j.erro || 'Recusado pelo recebedor.'); err.dados = j; err.servidor = true; throw err; }
      return j;
    } finally { clearTimeout(t); }
  }
  const metaParaEnvio = (r) => ({ esquema: r.esquema, id: r.id, versaoApp: r.versaoApp, nomeRelatorio: r.nomeRelatorio, vendedor: r.vendedor, criadoEm: r.criadoEm,
    negocioId: r.negocioId, prospectNovo: r.prospectNovo, identificacao: r.identificacao, gps: r.gps, campos: r.campos, audios: r.audios, pdf: r.pdf,
    origem: r.origem, lancadoPor: r.lancadoPor, dataVisita: r.dataVisita, dataVisitaSemHora: r.dataVisitaSemHora });

  async function enviarRegistro(reg) {
    const arqs = await DB.arquivosDoRegistro(reg.id);
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      for (const a of arqs) {
        if (reg.enviados[a.nome]) continue;
        await postar({ acao: 'arquivo', registro_id: reg.id, pasta: reg.nomeRelatorio, nome: a.nome, mime: a.mime, b64: await blobParaB64(a.blob) });
        reg.enviados[a.nome] = true;
        await DB.put('registros', reg);
      }
      try {
        await postar({ acao: 'registro', registro_id: reg.id, pasta: reg.nomeRelatorio, registro: metaParaEnvio(reg), arquivos: arqs.map((a) => a.nome) });
        return;
      } catch (e) {
        if (e.dados && Array.isArray(e.dados.faltando) && e.dados.faltando.length && tentativa === 0) { e.dados.faltando.forEach((n) => { delete reg.enviados[n]; }); continue; }
        throw e;
      }
    }
  }

  async function enviarPendentes(manual) {
    if (S.enviando) return;
    const fila = S.registros.filter((r) => r.status !== 'enviado').sort((a, b) => Date.parse(a.criadoEm) - Date.parse(b.criadoEm));
    if (!fila.length) { if (manual) toast('Nada pendente.'); return; }
    if (!S.endpoint) { if (manual) toast('Configure o endereço do recebedor na aba Config.', 'erro'); return; }
    S.enviando = true;
    let ok = 0, falhas = 0;
    for (const reg of fila) {
      reg.status = 'enviando';
      atualizarTopo(); renderHistorico();
      try {
        await enviarRegistro(reg);
        reg.status = 'enviado'; reg.enviadoEm = new Date().toISOString(); reg.ultimoErro = ''; ok++;
      } catch (e) {
        reg.status = 'pendente'; reg.tentativas = (reg.tentativas || 0) + 1; reg.ultimoErro = String((e && e.message) || e); falhas++;
        await DB.put('registros', reg);
        if (!e.servidor) break; // sem rede: para e tenta de novo depois
        continue;
      }
      await DB.put('registros', reg);
    }
    S.enviando = false;
    atualizarTopo(); renderHistorico();
    if (ok) toast(ok + ' registro(s) enviado(s) ✓');
    else if (falhas && manual) toast('Não enviou: ' + (fila[0].ultimoErro || 'sem conexão'), 'erro');
  }

  /* ---------- carteira: o aparelho sempre se atualiza com o escritório ---------- */
  const SYNC_INTERVALO_MS = 5 * 60000;
  function textoSync() {
    if (S.sync.rodando) return 'Atualizando com o escritório…';
    const m = S.srv.meta;
    const q = m && m.quando ? 'Atualizado em ' + new Date(m.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Ainda não atualizado com o escritório';
    return q + (S.sync.erro ? ' · sem conexão com o escritório: ' + S.sync.erro : S.sync.aviso ? ' · ' + S.sync.aviso : '');
  }
  function renderSyncInfo() {
    ['sync-info', 'cfg-sync-info'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = textoSync(); });
  }

  async function sincronizar(manual) {
    if (S.sync.rodando) return;
    if (S.modoEscritorio) { if (manual) toast('No modo escritório não há carteira.'); return; }
    if (!S.endpoint || !S.token || !S.vendedor) { if (manual) toast('Informe o endereço, o seu nome e o código de acesso em Config.', 'erro'); return; }
    if (!navigator.onLine) { if (manual) toast('Sem sinal. Mostrando o que está salvo no aparelho.', 'erro'); return; }
    S.sync.rodando = true; S.sync.erro = ''; renderSyncInfo();
    try {
      const j = await postar({ acao: 'carteira' });
      if (j.carteira && L.mesmoVendedor(j.carteira.vendedor, S.vendedor)) {
        const negocios = j.carteira.negocios || [], visitas = j.carteira.visitas || [];
        const meta = { quando: new Date().toISOString(), geradoEm: j.carteira.gerado_em || '', versaoProc: j.carteira.versao_proc || '', vendedor: S.vendedor };
        await DB.salvarCarteira(negocios, visitas, meta);
        S.srv = { negocios, visitas, meta };
        S.sync.aviso = '';
        await limparArquivosLiberados();
        if (manual) toast('Carteira atualizada ✓ (' + negocios.length + ' negócio' + (negocios.length === 1 ? '' : 's') + ')');
      } else {
        S.sync.aviso = j.aviso || 'Nada novo do escritório.';
        if (manual) toast(S.sync.aviso);
      }
    } catch (e) {
      S.sync.erro = String((e && e.message) || e);
      if (manual) toast('Não atualizou: ' + S.sync.erro, 'erro');
    } finally {
      S.sync.rodando = false; S.sync.ultimaTentativa = Date.now();
      recomputar(); renderTudo();
    }
  }
  const sincronizarSePassou = () => { if (Date.now() - S.sync.ultimaTentativa > SYNC_INTERVALO_MS) sincronizar(); };

  /** Áudio/PDF já Liberados (texto de volta, PDF copiado no escritório) saem do aparelho; o registro e o texto ficam. */
  async function limparArquivosLiberados() {
    const mapa = srvVisitasPorId();
    let n = 0;
    for (const r of S.registros) {
      if (!L.podeLimparArquivos(r, mapa[r.id])) continue;
      try { await DB.limparArquivos(r.id); r.limpo = true; r.limpoEm = new Date().toISOString(); await DB.put('registros', r); n++; } catch (e) { /* tenta na próxima */ }
    }
    return n;
  }

  /** Troca o conteúdo de uma tela ignorando itens nulos (replaceChildren escreveria a palavra "null"). */
  function montar(raiz) { raiz.replaceChildren(...Array.prototype.slice.call(arguments, 1).filter((x) => x)); }

  /* ---------- tela: Negócios (lista) ---------- */
  function tagData(data) {
    const e = L.acaoVencida(data);
    return e === 'vencida' ? h('span', { class: 'estado erro' }, 'vencida') : e === 'hoje' ? h('span', { class: 'estado atencao' }, 'hoje') : null;
  }
  /** "R$ 6.162.000,00 · R$ 15.521,16/ha" — o valor do pivô sempre junto do custo por hectare. */
  function linhaProjeto(p) {
    if (!L.temValorProjeto(p)) return '';
    const rs = L.valorPorHa(p);
    return L.fmtReais(p.valor_total) + (rs ? ' · ' + L.fmtReais(rs) + '/ha' : '');
  }
  function itemLista(n) {
    const c = n.campos || {};
    const proj = linhaProjeto(n.projeto);
    const aguardando = !n.srv;
    return h('button', { type: 'button', class: 'neg', 'data-id': n.id, onclick: () => abrirFicha(n.id) },
      h('div', { class: 'neg-nome' }, L.rotuloNegocio(n)),
      h('div', { class: 'neg-linha' },
        c.etapa ? h('span', { class: 'estado' }, L.rotuloEtapa(c.etapa)) : null,
        aguardando ? h('span', { class: 'estado atencao' }, 'aguardando liberação') : null,
        n.srv && n.naoLiberadas.length ? h('span', { class: 'estado atencao' }, n.naoLiberadas.length + ' visita' + (n.naoLiberadas.length > 1 ? 's' : '') + ' não liberada' + (n.naoLiberadas.length > 1 ? 's' : '')) : null),
      proj ? h('div', { class: 'neg-proj' }, proj) : null,
      c.proxima_acao || c.proxima_acao_data
        ? h('div', { class: 'neg-acao' }, '➜ ' + (c.proxima_acao || 'Próxima ação') + (c.proxima_acao_data ? ' · ' + L.fmtDataBR(c.proxima_acao_data) : '') + ' ', tagData(c.proxima_acao_data))
        : null);
  }
  const filtroAtivo = () => !!(S.filtro.busca || S.filtro.municipio || S.filtro.etapa || S.filtro.vencidas);

  function renderItensLista() {
    const caixa = document.getElementById('lista-itens');
    if (!caixa) return;
    const vistos = L.filtrarNegocios(S.lista, S.filtro);
    const cont = document.getElementById('lista-contagem');
    const lim = document.getElementById('btn-limpar-filtros');
    if (lim) lim.hidden = !filtroAtivo();
    if (cont) cont.textContent = filtroAtivo() ? vistos.length + ' de ' + S.lista.length + ' negócios' : S.lista.length + ' negócio' + (S.lista.length === 1 ? '' : 's');
    if (!S.lista.length) caixa.replaceChildren(h('div', { class: 'vazio' }, 'Nenhum negócio ainda. O escritório envia os negócios da sua carteira; ou toque em "Novo negócio".'));
    else if (!vistos.length) caixa.replaceChildren(h('div', { class: 'vazio' }, 'Nenhum negócio com esses filtros.'));
    else caixa.replaceChildren(...vistos.map(itemLista));
  }

  function renderLista() {
    const raiz = $('#view-lista');
    const venc = L.acoesVencidas(S.lista);
    const muns = L.municipiosDisponiveis(S.lista), etapas = L.etapasDisponiveis(S.lista);
    const emAndamento = S.draft && S.draft.negocioSel && draftTemConteudo();
    const nomeAndamento = emAndamento ? (S.draft.negocioSel === 'NOVO' ? 'novo negócio' : (negocioPorId(S.draft.negocioSel) ? L.rotuloNegocio(negocioPorId(S.draft.negocioSel)) : 'negócio')) : '';

    const busca = h('input', { type: 'text', id: 'busca', value: S.filtro.busca, placeholder: 'Buscar cliente, fazenda, município ou telefone', autocomplete: 'off', 'aria-label': 'Buscar negócio',
      oninput: (e) => { S.filtro.busca = e.target.value; renderItensLista(); } });
    const selMun = h('select', { id: 'f-municipio', 'aria-label': 'Filtrar por município', onchange: (e) => { S.filtro.municipio = e.target.value; renderLista(); } },
      h('option', { value: '' }, 'Todos os municípios'), muns.map((m) => h('option', { value: m }, m)));
    selMun.value = S.filtro.municipio;
    const selEt = h('select', { id: 'f-etapa', 'aria-label': 'Filtrar por etapa', onchange: (e) => { S.filtro.etapa = e.target.value; renderLista(); } },
      h('option', { value: '' }, 'Todas as etapas'), etapas.map((x) => h('option', { value: x.v }, x.t)));
    selEt.value = S.filtro.etapa;
    const chkV = h('input', { type: 'checkbox', id: 'f-vencidas', checked: S.filtro.vencidas ? true : null, onchange: (e) => { S.filtro.vencidas = e.target.checked; renderLista(); } });

    montar(raiz,
      h('div', { class: 'card' },
        h('div', { class: 'reg-acoes' },
          h('button', { class: 'btn primario', id: 'btn-novo-negocio', type: 'button', onclick: () => iniciarVisita('NOVO') }, '➕ Novo negócio'),
          h('button', { class: 'btn', id: 'btn-sync', type: 'button', onclick: () => { sincronizar(true); enviarPendentes(); } }, '↻ Atualizar')),
        h('div', { class: 'ajuda', id: 'sync-info' }, textoSync())),
      emAndamento ? h('div', { class: 'card em-andamento', id: 'card-andamento' }, h('h2', null, 'Visita em andamento'), h('div', null, nomeAndamento),
        h('div', { class: 'reg-acoes' }, h('button', { class: 'btn primario pequeno', type: 'button', id: 'btn-continuar', onclick: () => iniciarVisita(S.draft.negocioSel) }, 'Continuar'),
          h('button', { class: 'btn pequeno perigo', type: 'button', onclick: () => { descartarVisita(); } }, 'Descartar'))) : null,
      venc.length ? h('div', { class: 'card alerta-acoes', id: 'card-vencidas' }, h('h2', null, 'Ações vencidas ou de hoje (' + venc.length + ')'),
        venc.slice(0, 5).map((x) => h('button', { type: 'button', class: 'linha-acao', 'data-id': x.n.id, onclick: () => abrirFicha(x.n.id) },
          h('strong', null, L.rotuloNegocio(x.n)),
          h('span', null, (x.n.campos.proxima_acao || 'Próxima ação') + ' · ' + L.fmtDataBR(x.n.campos.proxima_acao_data) + ' ', tagData(x.n.campos.proxima_acao_data)))),
        venc.length > 5 && !S.filtro.vencidas ? h('button', { class: 'link', type: 'button', onclick: () => { S.filtro.vencidas = true; renderLista(); } }, 'Ver todas (' + venc.length + ')') : null) : null,
      h('div', { class: 'card filtros' }, busca,
        h('div', { class: 'filtros-linha' }, selMun, selEt),
        h('label', { class: 'check pequeno' }, chkV, h('span', null, 'Só ações vencidas ou de hoje')),
        h('button', { class: 'link', type: 'button', id: 'btn-limpar-filtros', hidden: !filtroAtivo(), onclick: () => { S.filtro = { busca: '', municipio: '', etapa: '', vencidas: false }; renderLista(); } }, 'Limpar filtros')),
      h('div', { class: 'ajuda', id: 'lista-contagem' }),
      h('div', { id: 'lista-itens', class: 'lista-itens' }));
    renderItensLista();
  }

  /* ---------- tela: Ficha do negócio (somente leitura) ---------- */
  function abrirFicha(id) { S.fichaId = id; mostrarTela('ficha'); }
  const linhaFicha = (rot, valor, extra) => (valor ? h('div', { class: 'lin' }, h('span', { class: 'k' }, rot), h('span', { class: 'v' }, valor, extra || null)) : null);
  const numOuNull = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

  function cardProjeto(p) {
    if (!p) return null;
    const rs = L.valorPorHa(p);
    const fatos = [];
    if (numOuNull(p.area_ha) !== null) fatos.push(L.fmtNum(p.area_ha, 2) + ' ha');
    if (numOuNull(p.lances) !== null) fatos.push(p.lances + ' lances');
    if (numOuNull(p.n_pivos) !== null) fatos.push(p.n_pivos + (p.n_pivos === 1 ? ' pivô' : ' pivôs'));
    if (numOuNull(p.n_recalques)) fatos.push(p.n_recalques + (p.n_recalques === 1 ? ' recalque' : ' recalques'));
    if (numOuNull(p.n_equipamentos)) fatos.push(p.n_equipamentos + ' equipamento' + (p.n_equipamentos === 1 ? '' : 's'));
    const origem = p.importado ? 'Valor importado do CRM atual (sem a planilha de equipamentos).'
      : 'Projeto' + (p.versao ? ' v' + p.versao : '') + (p.data ? ' de ' + L.fmtDataBR(p.data) : '') + (p.tipo ? ' · ' + p.tipo : '');
    return h('div', { class: 'card', id: 'ficha-projeto' }, h('h2', null, 'Projeto vigente'),
      L.temValorProjeto(p) ? h('div', { class: 'proj-valores' },
        h('div', null, h('div', { class: 'proj-rot' }, 'Valor total'), h('div', { class: 'proj-num', id: 'proj-valor' }, L.fmtReais(p.valor_total))),
        h('div', null, h('div', { class: 'proj-rot' }, 'Custo por hectare'), h('div', { class: 'proj-num', id: 'proj-rsha' }, rs ? L.fmtReais(rs) + '/ha' : '—'))) : null,
      fatos.length ? h('div', { class: 'proj-fatos' }, fatos.join(' · ')) : null,
      h('div', { class: 'ajuda' }, origem));
  }

  function renderFicha() {
    const raiz = $('#view-ficha');
    const n = negocioPorId(S.fichaId);
    const voltar = h('div', { class: 'barra-voltar' }, h('button', { class: 'btn pequeno', type: 'button', id: 'btn-ficha-voltar', onclick: () => mostrarTela('lista') }, '← Negócios'));
    if (!n) { raiz.replaceChildren(voltar, h('div', { class: 'vazio' }, 'Negócio não encontrado neste aparelho.')); return; }
    const c = n.campos || {};
    const mapa = L.mapaLink(n.gps);
    const datas = n.srv ? [n.primeira, n.ultima] : [n.regs.length ? n.regs[0].criadoEm : '', n.regs.length ? n.regs[n.regs.length - 1].criadoEm : ''];
    const nVis = n.srv ? n.nVisitas : n.regs.length;
    const def = (k) => L.campoPorChave(k);
    const situacao = ['etapa', 'motivo', 'probabilidade', 'previsao_compra', 'concorrente', 'concorrente_nome', 'pagamento_tipo', 'pagamento_detalhe', 'tipo_sistema', 'segmentacao', 'origem', 'est_pivos', 'est_hectares']
      .map((k) => linhaFicha(def(k).rotulo, L.textoCampo(def(k), c[k]))).filter(Boolean);
    const conversa = ['assunto', 'observacoes'].map((k) => linhaFicha(def(k).rotulo, L.textoCampo(def(k), c[k]))).filter(Boolean);
    const aviso = n.srv && n.regs.some((r) => !srvVisitasPorId()[r.id]) ? 'Há visita sua ainda não refletida pelo escritório; os campos já mostram o que você registrou.' : '';

    montar(raiz, voltar,
      h('div', { class: 'card' }, h('h2', null, 'Negócio'),
        h('div', { class: 'ficha-nome', id: 'ficha-nome' }, L.rotuloNegocio(n)),
        n.telefone ? h('div', { class: 'ficha-tel' }, h('a', { href: 'tel:' + String(n.telefone).replace(/[^\d+]/g, ''), id: 'ficha-tel' }, '📞 ' + n.telefone)) : null,
        h('div', { class: 'ajuda' }, nVis + ' visita' + (nVis === 1 ? '' : 's') + (datas[0] ? ' · primeira ' + L.fmtDataBR(datas[0]) : '') + (datas[1] ? ' · última ' + L.fmtDataBR(datas[1]) : '')),
        !n.srv ? h('div', { class: 'ajuda' }, 'Criado neste aparelho — aguardando o escritório liberar.') : null,
        aviso ? h('div', { class: 'ajuda' }, aviso) : null,
        h('div', { class: 'reg-acoes' },
          h('button', { class: 'btn primario', id: 'btn-atualizar-negocio', type: 'button', onclick: () => iniciarVisita(n.id) }, 'Atualizar negócio'),
          mapa ? h('a', { class: 'btn', id: 'btn-mapa', href: mapa, target: '_blank', rel: 'noopener' }, '📍 Abrir no mapa') : null)),
      cardProjeto(n.projeto),
      c.proxima_acao || c.proxima_acao_data ? h('div', { class: 'card', id: 'ficha-acao' }, h('h2', null, 'Próxima ação'),
        h('div', null, c.proxima_acao || '—'), c.proxima_acao_data ? h('div', { class: 'ajuda' }, 'Para ' + L.fmtDataBR(c.proxima_acao_data) + ' ', tagData(c.proxima_acao_data)) : null) : null,
      situacao.length ? h('div', { class: 'card' }, h('h2', null, 'Situação'), situacao) : null,
      conversa.length ? h('div', { class: 'card' }, h('h2', null, 'Última conversa'), conversa) : null,
      n.naoLiberadas.length ? h('div', { class: 'card', id: 'ficha-nao-liberadas' }, h('h2', null, 'Suas visitas ainda não liberadas'),
        n.naoLiberadas.map((r) => { const st = L.statusVisita(r, srvVisitasPorId()[r.id]); return h('div', { class: 'lin' }, h('span', { class: 'k' }, new Date(r.criadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })), h('span', { class: 'v' }, h('span', { class: 'estado ' + st.tom }, st.texto))); })) : null,
      n.historico.length ? h('div', { class: 'card', id: 'ficha-historico' }, h('h2', null, 'Histórico no escritório'),
        n.historico.map((x) => h('div', { class: 'hist' }, h('div', { class: 'hist-cab' }, h('strong', null, x.tipo), ' · ' + x.quando + (x.vendedor ? ' · ' + x.vendedor : '')), h('div', { class: 'hist-texto' }, x.texto)))) : null);
  }

  /* ---------- tela: Histórico (visitas feitas neste aparelho + as que o escritório tem em seu nome) ---------- */
  let urlsHist = [];
  function itensHistorico() {
    const mapa = srvVisitasPorId();
    const ids = {};
    S.registros.forEach((r) => { ids[r.id] = true; });
    const locais = S.registros.map((r) => ({ r, sv: mapa[r.id], ms: Date.parse(r.criadoEm) || 0 }));
    const soSrv = S.srv.visitas.filter((v) => !ids[v.id]).map((v) => ({ r: null, sv: v, ms: L.parseQuando(v.quando) }));
    return locais.concat(soSrv).sort((a, b) => b.ms - a.ms);
  }
  function tituloVisitaSrv(sv) {
    const n = negocioPorId(sv.negocio) || negocioPorId(sv.negocio_app);
    const nome = n ? L.rotuloNegocio(n) : L.rotuloNegocio({ cliente: sv.cliente, fazenda: sv.fazenda, municipio: sv.municipio });
    return nome;
  }
  function detalheVisita(it) {
    const r = it.r, sv = it.sv;
    const id = r ? r.id : sv.id;
    const campos = Object.assign({}, r ? r.campos : {}, sv ? sv.campos : {}); // o texto do escritório vale
    const linhas = [];
    const ident = sv ? { cliente: sv.cliente, fazenda: sv.fazenda, municipio: sv.municipio } : (r ? r.identificacao : {}) || {};
    if (r && r.prospectNovo) ['cliente', 'fazenda', 'municipio'].forEach((k) => linhas.push(linhaFicha(L.campoPorChave(k).rotulo, ident[k])));
    L.CAMPOS.filter((c) => c.grupo !== 'ident' && c.tipo !== 'arquivo').forEach((d) => linhas.push(linhaFicha(d.rotulo, L.textoCampo(d, campos[d.key]))));
    const caixaAudio = h('div', { class: 'aud', id: 'aud-' + id });
    if (r && r.limpo) caixaAudio.append(h('div', { class: 'ajuda' }, 'Áudio e PDF já foram guardados no escritório e saíram do aparelho para liberar espaço; os textos continuam aqui.'));
    else if (r && Object.keys(r.audios || {}).length) {
      DB.arquivosDoRegistro(r.id).then((arqs) => {
        arqs.filter((a) => /^audio/.test(a.mime || '')).forEach((a) => {
          const chave = a.nome.replace(/^ident_/, '').replace(/\.[^.]+$/, '');
          const d = L.campoPorChave(chave);
          const u = URL.createObjectURL(a.blob); urlsHist.push(u);
          caixaAudio.append(h('div', { class: 'ajuda' }, '🎤 ' + (d ? d.rotulo : chave)), h('audio', { controls: true, src: u, preload: 'metadata' }));
        });
      }).catch(() => {});
    }
    return h('div', { class: 'detalhe' }, linhas.filter(Boolean), caixaAudio);
  }
  function cardHist(it) {
    const r = it.r, sv = it.sv;
    const id = r ? r.id : sv.id;
    const st = L.statusVisita(r, sv);
    const aberto = S.histAberto === id;
    const acoes = [h('button', { class: 'btn pequeno', type: 'button', 'data-acao': 'detalhe', onclick: () => { S.histAberto = aberto ? '' : id; renderHistorico(); } }, aberto ? 'Fechar' : 'Ver detalhes')];
    if (r) {
      if (r.status !== 'enviado') acoes.push(h('button', { class: 'btn pequeno primario', type: 'button', onclick: () => enviarPendentes(true) }, 'Enviar agora'));
      acoes.push(h('button', {
        class: 'btn pequeno perigo', type: 'button',
        onclick: async () => {
          if (!confirm(r.status === 'enviado' ? 'Excluir este registro do aparelho? (ele já foi enviado)' : 'Este registro ainda NÃO foi enviado. Excluir mesmo assim?')) return;
          await DB.excluirRegistro(r.id);
          S.registros = S.registros.filter((x) => x.id !== r.id);
          recomputar(); renderTudo();
        },
      }, 'Excluir'));
    }
    const quando = r ? new Date(r.criadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : L.fmtQuando(sv.quando);
    const meta = !r ? quando + ' · ' + (sv.origem === 'Escritório' ? 'lançada pelo escritório' : 'registrada antes, recuperada do escritório')
      : r.origem === 'escritorio'
        ? 'Lançamento do escritório · visita de ' + new Date(r.dataVisita).toLocaleDateString('pt-BR') + (r.dataVisitaSemHora ? '' : ' ' + new Date(r.dataVisita).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) + ' · ' + L.fmtBytes(r.bytes || 0)
        : quando + ' · ' + L.fmtBytes(r.bytes || 0) + (r.gps ? ' · GPS ±' + r.gps.acuraciaM + ' m' : r.presenca === 'distancia' ? ' · à distância' : ' · sem GPS') + (r.limpo ? ' · áudios já no escritório' : '');
    return h('div', { class: 'card reg', 'data-id': id },
      h('div', { class: 'reg-nome' }, r ? r.nomeRelatorio : tituloVisitaSrv(sv)),
      h('div', { class: 'reg-meta' }, meta),
      h('div', null, h('span', { class: 'estado ' + st.tom, 'data-status': st.codigo }, st.texto)),
      sv && sv.a_conferir ? h('div', { class: 'ajuda' }, 'O escritório está conferindo alguns dados desta visita.') : null,
      r && r.ultimoErro && r.status !== 'enviado' ? h('div', { class: 'ajuda' }, 'Último erro: ' + r.ultimoErro) : null,
      aberto ? detalheVisita(it) : null,
      h('div', { class: 'reg-acoes' }, acoes));
  }
  function renderHistorico() {
    const raiz = $('#view-historico');
    urlsHist.forEach((u) => URL.revokeObjectURL(u)); urlsHist = [];
    const itens = itensHistorico();
    if (!itens.length) { raiz.replaceChildren(h('div', { class: 'vazio' }, 'Nenhum registro ainda.')); return; }
    raiz.replaceChildren(...itens.map(cardHist));
  }

  /* ---------- tela: Config ---------- */
  async function trocarVendedor(v) {
    const mudou = !!(S.srv.meta && S.srv.meta.vendedor && !L.mesmoVendedor(S.srv.meta.vendedor, v));
    S.vendedor = v; gravarCfg(); atualizarTopo();
    if (mudou) { try { await DB.limparCarteira(); } catch (e) { /* segue */ } S.srv = { negocios: [], visitas: [], meta: null }; recomputar(); renderTudo(); }
    S.sync.ultimaTentativa = 0;
    sincronizar();
  }
  function renderConfig() {
    const raiz = $('#view-config');
    const campoVend = S.vendedores.length
      ? (() => { const s = h('select', { id: 'cfg-vendedor', onchange: (e) => { trocarVendedor(e.target.value); } },
          h('option', { value: '' }, 'Escolha…'), S.vendedores.map((v) => h('option', { value: v }, v))); s.value = S.vendedor; return s; })()
      : h('input', { type: 'text', id: 'cfg-vendedor', value: S.vendedor, placeholder: 'Seu nome', autocomplete: 'off', onchange: (e) => { trocarVendedor(e.target.value.trim()); } });
    const ep = h('input', { type: 'url', id: 'cfg-endpoint', value: S.endpoint, placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' });
    const tk = h('input', { type: 'password', id: 'cfg-token', value: S.token, placeholder: 'Código de acesso', autocomplete: 'off' });
    const infoArm = h('div', { class: 'ajuda', id: 'cfg-armazenamento' }, 'Calculando…');
    const salvarCfgBtn = h('button', { class: 'btn primario', type: 'button', id: 'cfg-salvar', onclick: () => {
      S.endpoint = ep.value.trim(); S.token = tk.value.trim(); gravarCfg(); toast('Configuração salva ✓'); enviarPendentes(); S.sync.ultimaTentativa = 0; sincronizar(true);
    } }, 'Salvar configuração');
    const teste = h('div', { class: 'ajuda', id: 'cfg-teste' });
    const modo = h('input', { type: 'checkbox', id: 'cfg-modo-escritorio', checked: S.modoEscritorio ? true : null, onchange: (e) => {
      S.modoEscritorio = e.target.checked; gravarCfg();
      if (S.modoEscritorio) pararGPS();
      renderTudo();
    } });
    raiz.replaceChildren(
      h('div', { class: 'card' }, h('h2', null, 'Vendedor'), campoVend),
      h('div', { class: 'card' }, h('h2', null, 'Carteira do escritório'),
        h('div', { class: 'ajuda', id: 'cfg-sync-info' }, textoSync()),
        h('div', { class: 'reg-acoes' }, h('button', { class: 'btn', type: 'button', id: 'cfg-sync', onclick: () => { sincronizar(true); } }, '↻ Atualizar carteira agora')),
        h('p', { class: 'ajuda' }, 'O aparelho se atualiza sozinho com o escritório (status das suas visitas, textos transcritos e os negócios da sua carteira). Sem sinal, tudo o que já veio continua disponível para consulta.')),
      h('div', { class: 'card' }, h('h2', null, 'Lançamento do escritório'),
        h('label', { class: 'check' }, modo, h('span', null, 'Lançar visita em nome de um vendedor')),
        h('p', { class: 'ajuda' }, 'Para digitar no escritório uma visita que o vendedor contou: sem GPS, com o nome do vendedor e a data real da visita. Exige o código-mestre do escritório. Desligue para voltar ao modo de campo.')),
      h('div', { class: 'card' }, h('h2', null, 'Envio ao escritório'),
        h('div', { class: 'campo' }, h('div', { class: 'rotulo' }, 'Endereço do recebedor'), ep),
        h('div', { class: 'campo' }, h('div', { class: 'rotulo' }, 'Código de acesso'), tk, h('div', { class: 'ajuda' }, 'Pessoal: é o código que o escritório entregou para o seu nome.')),
        h('div', { class: 'reg-acoes' }, salvarCfgBtn,
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            S.endpoint = ep.value.trim(); S.token = tk.value.trim(); gravarCfg();
            teste.textContent = 'Testando…';
            try {
              const r = await fetch(S.endpoint + (S.endpoint.indexOf('?') >= 0 ? '&' : '?') + 'acao=ping', { redirect: 'follow' });
              const j = await r.json();
              teste.textContent = j && j.ok ? '✓ Recebedor respondeu (versão ' + j.versao + ').' : 'Respondeu, mas algo está errado.';
            } catch (e) { teste.textContent = '✗ Sem resposta. Sem sinal ou endereço incorreto.'; }
          } }, 'Testar conexão'),
          h('button', { class: 'btn', type: 'button', onclick: async () => {
            const link = location.origin + location.pathname + '#cfg=' + b64uEnc(JSON.stringify({ endpoint: S.endpoint, token: S.token, vendedor: S.vendedor, vendedores: S.vendedores }));
            try { await navigator.clipboard.writeText(link); toast('Link de configuração copiado.'); } catch (e) { prompt('Copie o link:', link); }
          } }, 'Copiar link de configuração')),
        teste,
        h('p', { class: 'ajuda' }, 'O link de configuração leva endereço, nome e código de acesso para outro aparelho seu. Não envie para outra pessoa.')),
      h('div', { class: 'card' }, h('h2', null, 'Aparelho'),
        infoArm,
        h('div', { class: 'ajuda' }, 'Versão do app: ' + L.APP_VERSAO),
        S.instalar ? h('button', { class: 'btn', type: 'button', onclick: async () => { S.instalar.prompt(); S.instalar = null; renderConfig(); } }, 'Instalar app na tela inicial') : null,
        h('p', { class: 'ajuda' }, 'Áudios e PDFs saem do aparelho sozinhos depois que o escritório libera a visita e devolve o texto. Campos na tela: visita em negócio existente ' + L.contarCampos({}) + ' · prospect novo ' + L.contarCampos({ prospect: true }) +
          ' · com opcionais ' + L.contarCampos({ prospect: true, opcionais: true }) + ' (+1 se a etapa for Ganho ou Perdido).'))
    );
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((e) => {
        const persistente = navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false);
        persistente.then((p) => { infoArm.textContent = 'Armazenamento: ' + L.fmtBytes(e.usage || 0) + ' usados · proteção contra limpeza: ' + (p ? 'ativa' : 'não concedida'); });
      }).catch(() => { infoArm.textContent = ''; });
    } else infoArm.textContent = '';
  }

  /* ---------- topo, abas, vendedor ---------- */
  function atualizarTopo() {
    const online = navigator.onLine;
    const pill = $('#pill-rede');
    pill.textContent = online ? 'online' : 'sem sinal';
    pill.className = 'pill' + (online ? '' : ' offline');
    $('#topo-vendedor').textContent = S.modoEscritorio ? 'MODO ESCRITÓRIO — lançamento' : (S.vendedor || 'defina o vendedor em Config');
    document.body.classList.toggle('modo-escritorio', !!S.modoEscritorio);
    const pend = S.registros.filter((r) => r.status !== 'enviado').length;
    $('#topo-pendentes').textContent = S.enviando ? 'enviando…' : pend ? pend + ' pendente' + (pend > 1 ? 's' : '') : (S.registros.length ? 'tudo enviado ✓' : '');
  }
  const TELAS = ['lista', 'ficha', 'visita', 'historico', 'config'];
  const ABA_DA_TELA = { lista: 'negocios', ficha: 'negocios', visita: 'negocios', historico: 'historico', config: 'config' };
  function renderTela() {
    ({ lista: renderLista, ficha: renderFicha, visita: renderVisita, historico: renderHistorico, config: renderConfig }[S.tela] || renderLista)();
  }
  function mostrarTela(t) {
    S.tela = t;
    TELAS.forEach((x) => { $('#view-' + x).hidden = x !== t; });
    document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === ABA_DA_TELA[t]));
    $('#barra-salvar').hidden = t !== 'visita';
    atualizarTopo();
    renderTela();
    window.scrollTo(0, 0);
  }
  // não refaz a tela da visita no meio de uma gravação ou digitação: ela só muda por ações do próprio vendedor
  function renderTudo() {
    atualizarTopo();
    if (S.tela === 'visita') return;
    const foco = document.activeElement;
    if (S.tela === 'lista' && foco && foco.id === 'busca') { renderItensLista(); renderSyncInfo(); return; } // não tira o teclado de quem está digitando
    renderTela();
  }

  function pedirVendedor() {
    const campo = S.vendedores.length
      ? (() => { const s = h('select', { id: 'modal-vendedor' }, h('option', { value: '' }, 'Escolha seu nome…'), S.vendedores.map((v) => h('option', { value: v }, v))); return s; })()
      : h('input', { type: 'text', id: 'modal-vendedor', placeholder: 'Seu nome completo', autocomplete: 'off' });
    modal([h('h3', null, 'Quem é você?'), h('p', { class: 'ajuda' }, 'O nome vai na frente de cada relatório que você enviar. Use o mesmo nome cadastrado no escritório.'), campo,
      h('button', { class: 'btn primario', type: 'button', id: 'modal-vendedor-ok', onclick: () => {
        const v = campo.value.trim();
        if (!v) { toast('Informe seu nome.', 'erro'); return; }
        fecharModal(); trocarVendedor(v); if (S.tela === 'config') renderConfig();
      } }, 'Continuar')]);
  }

  /* ---------- início ---------- */
  async function iniciar() {
    const c = lerCfg();
    S.vendedor = c.vendedor || ''; S.endpoint = c.endpoint || ''; S.token = c.token || ''; S.vendedores = c.vendedores || []; S.modoEscritorio = !!c.modoEscritorio;
    const veioLink = aplicarLinkConfig();
    try { S.registros = await DB.todosRegistros(); } catch (e) { S.registros = []; toast('Armazenamento local indisponível neste navegador.', 'erro'); }
    try {
      const r = await Promise.all([DB.todos('negocios'), DB.todos('visitas_srv'), DB.get('meta', 'sync')]);
      S.srv = { negocios: r[0] || [], visitas: r[1] || [], meta: r[2] || null };
    } catch (e) { S.srv = { negocios: [], visitas: [], meta: null }; }
    recomputar();
    try { S.draft = (await DB.get('rascunho', 'atual')) || novoDraft(); } catch (e) { S.draft = novoDraft(); }
    S.draft = Object.assign(novoDraft(), S.draft);
    S.draft.texto = Object.assign(novoDraft().texto, S.draft.texto);
    if (S.draft.negocioSel && S.draft.negocioSel !== 'NOVO' && !negocioPorId(S.draft.negocioSel)) S.draft = novoDraft();

    document.querySelectorAll('#abas button').forEach((b) => b.addEventListener('click', () => mostrarTela(b.dataset.aba === 'negocios' ? 'lista' : b.dataset.aba)));
    $('#btn-salvar').addEventListener('click', salvar);
    window.addEventListener('online', () => { atualizarTopo(); enviarPendentes(); S.sync.ultimaTentativa = 0; sincronizar(); });
    window.addEventListener('offline', atualizarTopo);
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.tela === 'config') renderConfig(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (S.tela === 'visita' && !S.modoEscritorio && S.draft.presenca !== 'distancia' && (!S.gps.best || Date.now() - S.gps.best.ts > 10 * 60000)) iniciarGPS();
      enviarPendentes();
      sincronizarSePassou();
    });
    setInterval(() => { if (navigator.onLine) { enviarPendentes(); sincronizarSePassou(); } }, 90000);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    await limparArquivosLiberados();
    mostrarTela('lista');
    if (!S.vendedor && !S.modoEscritorio) pedirVendedor();
    if (veioLink) toast('Configuração recebida ✓');
    enviarPendentes();
    sincronizar();
  }

  window.__CRM = { S, DB, L, sincronizar, recomputar }; // facilita testes e diagnóstico
  iniciar();
})();
