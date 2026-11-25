/* app.js — CRM Visitas · Copasul (PWA, funciona sem sinal)
 * Fluxo: abre → GPS automático → escolhe negócio → grava por voz cada campo → salva → envia quando houver sinal. */
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
    vendedor: '', vendedores: [], endpoint: '', token: '',
    aba: 'visita', draft: null, registros: [],
    gps: { status: 'idle', best: null, watchId: null, timer: null },
    rec: null, enviando: false, instalar: null, opcionalAberto: false,
  };
  const novoDraft = () => ({ negocioSel: '', valores: {}, texto: { cliente: '', fazenda: '', municipio: '' }, audios: {}, pdf: null });
  const temOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* ---------- configuração local ---------- */
  const CFG_KEY = 'crmcopasul.cfg';
  function lerCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } }
  function gravarCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify({ vendedor: S.vendedor, endpoint: S.endpoint, token: S.token, vendedores: S.vendedores })); } catch (e) { /* sem storage */ }
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
      if (Array.isArray(o.vendedores)) S.vendedores = o.vendedores;
      gravarCfg();
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    } catch (e) { return false; }
  }

  /* ---------- banco local (IndexedDB) ---------- */
  const DB = {
    _db: null,
    abrir() {
      if (this._db) return this._db;
      this._db = new Promise((res, rej) => {
        const r = indexedDB.open('crm-copasul', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('registros', { keyPath: 'id' });
          db.createObjectStore('arquivos', { keyPath: 'chave' }).createIndex('registro', 'registroId');
          db.createObjectStore('rascunho');
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
    todosRegistros() { return this._tx('registros', 'readonly', (t) => t.objectStore('registros').getAll()); },
    arquivosDoRegistro(id) { return this._tx('arquivos', 'readonly', (t) => t.objectStore('arquivos').index('registro').getAll(id)); },
    salvarRegistro(reg, arqs) {
      return this._tx(['registros', 'arquivos'], 'readwrite', (t) => {
        t.objectStore('registros').put(reg);
        arqs.forEach((a) => t.objectStore('arquivos').put(a));
      });
    },
    excluirRegistro(id) {
      return this._tx(['registros', 'arquivos'], 'readwrite', (t) => {
        t.objectStore('registros').delete(id);
        const rq = t.objectStore('arquivos').index('registro').openKeyCursor(IDBKeyRange.only(id));
        rq.onsuccess = () => { const c = rq.result; if (c) { t.objectStore('arquivos').delete(c.primaryKey); c.continue(); } };
      });
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
    return Object.keys(d.valores).length || Object.keys(d.audios).length || d.pdf || d.texto.cliente || d.texto.fazenda || d.texto.municipio;
  };

  /* ---------- valores atuais (último estado conhecido do negócio) ---------- */
  const atualDoNegocio = (id) => L.mesclarCampos(S.registros.filter((r) => r.negocioId === id));
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
    const chips = L.opcoesDoCampo(def, ef).map((o) =>
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
      h('div', { class: 'ajuda' }, 'Os dados do projeto (pivôs, lances, hectares, valores) são extraídos no escritório.'),
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
  function campoVoz(def) { return envolver(def, widgetVoz(def)); }
  function campoTextoVoz(def) {
    return envolver(def, h('div', { class: 'texto-voz' },
      h('input', { type: 'text', placeholder: def.exemplo, value: S.draft.texto[def.key], autocomplete: 'off', 'aria-label': def.rotulo,
        oninput: (e) => { S.draft.texto[def.key] = e.target.value; agendarRascunho(); } }),
      widgetVoz(def)));
  }

  function renderCampo(def, ef, atual) {
    switch (def.tipo) {
      case 'voz': return campoVoz(def);
      case 'texto_voz': return campoTextoVoz(def);
      case 'opcoes': return campoOpcoes(def, ef, atual);
      case 'sim_nao': return campoSimNao(def, ef, atual);
      case 'multi': return campoMulti(def, ef, atual);
      case 'estrelas': return campoEstrelas(def, ef, atual);
      case 'mes': case 'data': return campoDataMes(def, ef, atual);
      case 'arquivo': return campoPdf(def);
      default: return null;
    }
  }

  /* ---------- tela: Visita ---------- */
  function onNegocio(e) {
    const novo = e.target.value;
    if (novo !== S.draft.negocioSel && draftTemConteudo()) {
      if (!confirm('Trocar o negócio descarta o que já foi preenchido. Continuar?')) { e.target.value = S.draft.negocioSel; return; }
    }
    if (novo !== S.draft.negocioSel) {
      liberarUrls();
      S.draft = novoDraft();
      S.draft.negocioSel = novo;
      agendarRascunho();
    }
    renderVisita();
  }

  function cardNegocio() {
    const lista = L.listaNegocios(S.registros);
    const sel = h('select', { id: 'sel-negocio', 'aria-label': 'Negócio', onchange: onNegocio },
      h('option', { value: '' }, 'Escolha o negócio…'),
      h('option', { value: 'NOVO' }, '➕ Novo prospect'),
      lista.map((n) => h('option', { value: n.id }, L.rotuloNegocio(n) + (n.provisorio ? ' · novo' : ''))));
    sel.value = S.draft.negocioSel;
    const filhos = [h('h2', null, 'Negócio'), sel];
    const ex = lista.find((n) => n.id === S.draft.negocioSel);
    if (ex) filhos.push(h('div', { class: 'atual' }, 'Última visita: ' + new Date(ex.ultimaVisita).toLocaleDateString('pt-BR')));
    if (S.draft.negocioSel === 'NOVO') {
      filhos.push(h('p', { class: 'ajuda' }, 'Digite ou grave o nome. Se gravar, o escritório completa a identificação.'));
      L.CAMPOS.filter((c) => c.grupo === 'ident').forEach((def) => filhos.push(renderCampo(def, {}, {})));
    }
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

  function renderVisita() {
    const raiz = $('#view-visita');
    const ef = valoresEfetivos();
    const atual = negocioAtualMapa();
    const cards = [
      h('div', { class: 'card' }, h('h2', null, 'Local do registro'), h('div', { id: 'gps-corpo' })),
      cardNegocio(),
    ];
    if (S.draft.negocioSel) cards.push(cardRelatorio(ef, atual), cardOpcionais(ef, atual));
    raiz.replaceChildren(...cards);
    renderGps();
  }

  /* ---------- salvar ---------- */
  function mostrarErros(erros) {
    modal([h('h3', null, 'Falta preencher'), h('ul', { class: 'erros' }, erros.map((e) => h('li', null, e))),
      h('button', { class: 'btn primario', type: 'button', onclick: fecharModal }, 'Entendi')]);
  }

  async function salvar() {
    if (S.rec) await pararGravacao();
    const erros = L.validarRegistro(S.draft);
    if (erros.length) { mostrarErros(erros); return; }
    if (!S.vendedor) { pedirVendedor(); return; }
    const btn = $('#btn-salvar');
    btn.disabled = true;
    try {
      const agora = new Date();
      const novo = S.draft.negocioSel === 'NOVO';
      const negocioId = novo ? L.gerarCodigoProvisorio(agora) : S.draft.negocioSel;
      const conhecido = novo ? null : L.listaNegocios(S.registros).find((n) => n.id === negocioId);
      const ident = novo
        ? { cliente: S.draft.texto.cliente.trim(), fazenda: S.draft.texto.fazenda.trim(), municipio: S.draft.texto.municipio.trim() }
        : { cliente: conhecido.cliente, fazenda: conhecido.fazenda, municipio: conhecido.municipio };
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
      visiveis.forEach((def) => { if (temOwn(S.draft.valores, def.key)) campos[def.key] = S.draft.valores[def.key]; });
      const b = S.gps.best;
      const reg = {
        esquema: 1, id, versaoApp: L.APP_VERSAO,
        nomeRelatorio: L.nomeRelatorio({ vendedor: S.vendedor, cliente: ident.cliente, fazenda: ident.fazenda, municipio: ident.municipio, data: agora }),
        vendedor: S.vendedor, criadoEm: agora.toISOString(), negocioId, prospectNovo: novo,
        identificacao: { cliente: ident.cliente, fazenda: ident.fazenda, municipio: ident.municipio, porVoz },
        gps: b ? { lat: b.lat, lng: b.lng, acuraciaM: Math.round(b.acc), capturadoEm: new Date(b.ts).toISOString() } : null,
        campos, audios: audiosMeta, pdf: pdfMeta,
        status: 'pendente', enviados: {}, tentativas: 0, ultimoErro: '', bytes: arquivos.reduce((s, a) => s + a.bytes, 0),
      };
      await DB.salvarRegistro(reg, arquivos);
      S.registros.push(reg);
      liberarUrls();
      S.draft = novoDraft();
      await DB.put('rascunho', S.draft, 'atual');
      toast(b ? 'Registro salvo ✓ — pendente de envio' : 'Registro salvo SEM ponto GPS — pendente de envio');
      renderTudo();
      window.scrollTo(0, 0);
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
      const resp = await fetch(S.endpoint, { method: 'POST', body: JSON.stringify(Object.assign({}, obj, { token: S.token })), signal: ctrl.signal, redirect: 'follow' });
      const txt = await resp.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('Resposta inesperada do recebedor.'); }
      if (!j.ok) { const err = new Error(j.erro || 'Recusado pelo recebedor.'); err.dados = j; err.servidor = true; throw err; }
      return j;
    } finally { clearTimeout(t); }
  }
  const metaParaEnvio = (r) => ({ esquema: r.esquema, id: r.id, versaoApp: r.versaoApp, nomeRelatorio: r.nomeRelatorio, vendedor: r.vendedor, criadoEm: r.criadoEm,
    negocioId: r.negocioId, prospectNovo: r.prospectNovo, identificacao: r.identificacao, gps: r.gps, campos: r.campos, audios: r.audios, pdf: r.pdf });

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

  /* ---------- tela: Histórico ---------- */
  function cardReg(r) {
    const st = r.status === 'enviado' ? ['ok', 'Enviado ✓'] : r.status === 'enviando' ? ['atencao', 'Enviando…'] : ['atencao', 'Pendente'];
    const quando = new Date(r.criadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const acoes = [];
    if (r.status !== 'enviado') acoes.push(h('button', { class: 'btn pequeno primario', type: 'button', onclick: () => enviarPendentes(true) }, 'Enviar agora'));
    acoes.push(h('button', {
      class: 'btn pequeno perigo', type: 'button',
      onclick: async () => {
        if (!confirm(r.status === 'enviado' ? 'Excluir este registro do aparelho? (ele já foi enviado)' : 'Este registro ainda NÃO foi enviado. Excluir mesmo assim?')) return;
        await DB.excluirRegistro(r.id);
        S.registros = S.registros.filter((x) => x.id !== r.id);
        renderTudo();
      },
    }, 'Excluir'));
    return h('div', { class: 'card reg' },
      h('div', { class: 'reg-nome' }, r.nomeRelatorio),
      h('div', { class: 'reg-meta' }, quando + ' · ' + L.fmtBytes(r.bytes || 0) + (r.gps ? ' · GPS ±' + r.gps.acuraciaM + ' m' : ' · sem GPS')),
      h('div', null, h('span', { class: 'estado ' + st[0] }, st[1])),
      r.ultimoErro && r.status !== 'enviado' ? h('div', { class: 'ajuda' }, 'Último erro: ' + r.ultimoErro) : null,
      h('div', { class: 'reg-acoes' }, acoes));
  }
  function renderHistorico() {
    const raiz = $('#view-historico');
    const regs = S.registros.slice().sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm));
    if (!regs.length) { raiz.replaceChildren(h('div', { class: 'vazio' }, 'Nenhum registro ainda.')); return; }
    raiz.replaceChildren(...regs.map(cardReg));
  }

  /* ---------- tela: Config ---------- */
  function renderConfig() {
    const raiz = $('#view-config');
    const campoVend = S.vendedores.length
      ? (() => { const s = h('select', { id: 'cfg-vendedor', onchange: (e) => { S.vendedor = e.target.value; gravarCfg(); atualizarTopo(); } },
          h('option', { value: '' }, 'Escolha…'), S.vendedores.map((v) => h('option', { value: v }, v))); s.value = S.vendedor; return s; })()
      : h('input', { type: 'text', id: 'cfg-vendedor', value: S.vendedor, placeholder: 'Seu nome', autocomplete: 'off', onchange: (e) => { S.vendedor = e.target.value.trim(); gravarCfg(); atualizarTopo(); } });
    const ep = h('input', { type: 'url', id: 'cfg-endpoint', value: S.endpoint, placeholder: 'https://script.google.com/macros/s/…/exec', autocomplete: 'off' });
    const tk = h('input', { type: 'password', id: 'cfg-token', value: S.token, placeholder: 'Código de acesso', autocomplete: 'off' });
    const infoArm = h('div', { class: 'ajuda', id: 'cfg-armazenamento' }, 'Calculando…');
    const salvarCfgBtn = h('button', { class: 'btn primario', type: 'button', id: 'cfg-salvar', onclick: () => {
      S.endpoint = ep.value.trim(); S.token = tk.value.trim(); gravarCfg(); toast('Configuração salva ✓'); enviarPendentes();
    } }, 'Salvar configuração');
    const teste = h('div', { class: 'ajuda', id: 'cfg-teste' });
    raiz.replaceChildren(
      h('div', { class: 'card' }, h('h2', null, 'Vendedor'), campoVend),
      h('div', { class: 'card' }, h('h2', null, 'Envio ao escritório'),
        h('div', { class: 'campo' }, h('div', { class: 'rotulo' }, 'Endereço do recebedor'), ep),
        h('div', { class: 'campo' }, h('div', { class: 'rotulo' }, 'Código de acesso'), tk),
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
            const link = location.origin + location.pathname + '#cfg=' + b64uEnc(JSON.stringify({ endpoint: S.endpoint, token: S.token, vendedores: S.vendedores }));
            try { await navigator.clipboard.writeText(link); toast('Link de configuração copiado.'); } catch (e) { prompt('Copie o link:', link); }
          } }, 'Copiar link de configuração')),
        teste,
        h('p', { class: 'ajuda' }, 'O link de configuração leva endereço, código e lista de vendedores para outro aparelho. Envie só para quem vai usar o app.')),
      h('div', { class: 'card' }, h('h2', null, 'Aparelho'),
        infoArm,
        h('div', { class: 'ajuda' }, 'Versão do app: ' + L.APP_VERSAO),
        S.instalar ? h('button', { class: 'btn', type: 'button', onclick: async () => { S.instalar.prompt(); S.instalar = null; renderConfig(); } }, 'Instalar app na tela inicial') : null,
        h('p', { class: 'ajuda' }, 'Campos na tela: visita em negócio existente ' + L.contarCampos({}) + ' · prospect novo ' + L.contarCampos({ prospect: true }) +
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
    $('#topo-vendedor').textContent = S.vendedor || 'defina o vendedor em Config';
    const pend = S.registros.filter((r) => r.status !== 'enviado').length;
    $('#topo-pendentes').textContent = S.enviando ? 'enviando…' : pend ? pend + ' pendente' + (pend > 1 ? 's' : '') : (S.registros.length ? 'tudo enviado ✓' : '');
  }
  function mostrarAba(nome) {
    S.aba = nome;
    ['visita', 'historico', 'config'].forEach((a) => { $('#view-' + a).hidden = a !== nome; });
    document.querySelectorAll('#abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
    $('#barra-salvar').hidden = nome !== 'visita';
    if (nome === 'historico') renderHistorico();
    if (nome === 'config') renderConfig();
    window.scrollTo(0, 0);
  }
  function renderTudo() { atualizarTopo(); renderVisita(); renderHistorico(); if (S.aba === 'config') renderConfig(); }

  function pedirVendedor() {
    const campo = S.vendedores.length
      ? (() => { const s = h('select', { id: 'modal-vendedor' }, h('option', { value: '' }, 'Escolha seu nome…'), S.vendedores.map((v) => h('option', { value: v }, v))); return s; })()
      : h('input', { type: 'text', id: 'modal-vendedor', placeholder: 'Seu nome completo', autocomplete: 'off' });
    modal([h('h3', null, 'Quem é você?'), h('p', { class: 'ajuda' }, 'O nome vai na frente de cada relatório que você enviar.'), campo,
      h('button', { class: 'btn primario', type: 'button', id: 'modal-vendedor-ok', onclick: () => {
        const v = campo.value.trim();
        if (!v) { toast('Informe seu nome.', 'erro'); return; }
        S.vendedor = v; gravarCfg(); fecharModal(); atualizarTopo(); if (S.aba === 'config') renderConfig();
      } }, 'Continuar')]);
  }

  /* ---------- início ---------- */
  async function iniciar() {
    const c = lerCfg();
    S.vendedor = c.vendedor || ''; S.endpoint = c.endpoint || ''; S.token = c.token || ''; S.vendedores = c.vendedores || [];
    const veioLink = aplicarLinkConfig();
    try { S.registros = await DB.todosRegistros(); } catch (e) { S.registros = []; toast('Armazenamento local indisponível neste navegador.', 'erro'); }
    try { S.draft = (await DB.get('rascunho', 'atual')) || novoDraft(); } catch (e) { S.draft = novoDraft(); }
    S.draft = Object.assign(novoDraft(), S.draft);
    if (S.draft.negocioSel && S.draft.negocioSel !== 'NOVO' && !L.listaNegocios(S.registros).some((n) => n.id === S.draft.negocioSel)) S.draft = novoDraft();

    document.querySelectorAll('#abas button').forEach((b) => b.addEventListener('click', () => mostrarAba(b.dataset.aba)));
    $('#btn-salvar').addEventListener('click', salvar);
    window.addEventListener('online', () => { atualizarTopo(); enviarPendentes(); });
    window.addEventListener('offline', atualizarTopo);
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.instalar = e; if (S.aba === 'config') renderConfig(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!S.gps.best || Date.now() - S.gps.best.ts > 10 * 60000) iniciarGPS();
      enviarPendentes();
    });
    setInterval(() => { if (navigator.onLine) enviarPendentes(); }, 90000);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    renderTudo();
    mostrarAba('visita');
    iniciarGPS();
    if (!S.vendedor) pedirVendedor();
    if (veioLink) toast('Configuração recebida ✓');
    enviarPendentes();
  }

  window.__CRM = { S, DB, L }; // facilita testes e diagnóstico
  iniciar();
})();
