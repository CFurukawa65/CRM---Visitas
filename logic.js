/* logic.js — regras puras do app CRM Visitas (sem DOM).
 * Roda no navegador (window.Logic) e no node (module.exports), para poder ser testado. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const APP_VERSAO = '1.3.0';
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  /* ---------- listas fechadas (vindas do CRM atual) ---------- */
  // GANHO / PERDIDO / 0-Arquivado: o escritório converte para a etapa/conclusão do CRM atual.
  // Prospecção: primeiro contato, antes da "Oportunidade mapeada". "Prospecção descartada": a prospecção não avançou (exige motivo).
  const ETAPA_PROSPECCAO = 'Prospecção';
  const ETAPA_DESCARTADA = 'Prospecção descartada';
  const ETAPAS = [
    { v: ETAPA_PROSPECCAO, t: 'Prospecção' },
    { v: '1-Oportunidade Mapeada', t: 'Oportunidade mapeada' },
    { v: '5-Projeto Pronto', t: 'Projeto pronto' },
    { v: '6-Apresentação realizada', t: 'Apresentação realizada' },
    { v: '3-Negociando', t: 'Negociando' },
    { v: 'GANHO', t: 'Ganho (fechou)' },
    { v: 'PERDIDO', t: 'Perdido' },
    { v: '0-Arquivado', t: 'Arquivar' },
    { v: ETAPA_DESCARTADA, t: 'Prospecção descartada' },
  ];
  const MOTIVOS_GANHO = ['Parcelamento RP', 'Preferência pela Marca', 'Qualidade de Projeto', 'Preço', 'Condições de Pagamento', 'Prazo de Entrega'];
  const MOTIVOS_PERDA = ['Preço', 'Problema de relacionamento', 'Preferência por Marca', 'Falta de Atendimento'];
  const MOTIVOS_DESCARTE = ['Sem interesse no momento', 'Sem área ou água viável', 'Já tem sistema ou concorrente', 'Sem retorno do contato', 'Outro'];
  const ORIGENS = ['Carteira de vendas', 'Indicação de parceiros', 'Canais Digitais', 'Eventos', 'Campanha Fábrica', 'Marketing'];
  const SEGMENTOS = ['Grãos', 'Pecuária', 'Cana'];
  const TIPOS_SISTEMA = ['Pivô central', 'Carretel', 'Aspersão', 'Outro'];

  const asOpcoes = (arr) => arr.map((x) => ({ v: x, t: x }));

  /* ---------- definição dos campos ----------
   * tipo: texto_voz | texto | telefone | voz | opcoes | estrelas | mes | data | sim_nao | multi | arquivo
   * max: duração máxima da gravação (s). obrigatorio: exige preenchimento para salvar.
   * numero: o campo dita só o número (o escritório grava como número).
   * grupo 'legado': não aparece mais no formulário; continua sendo lido para mostrar o que já foi registrado. */
  const CAMPOS = [
    // identificação (só "Novo negócio"): cliente e fazenda só digitados; município digitado OU por voz; telefone sempre digitado e opcional
    { key: 'cliente', grupo: 'ident', tipo: 'texto', rotulo: 'Nome do cliente', exemplo: 'Ex.: Valdemir Rossini', obrigatorio: true },
    { key: 'fazenda', grupo: 'ident', tipo: 'texto', rotulo: 'Fazenda', exemplo: 'Ex.: Fazenda Samambaia' },
    { key: 'municipio', grupo: 'ident', tipo: 'texto_voz', rotulo: 'Município', exemplo: 'Ex.: Batayporã', max: 30 },
    { key: 'telefone', grupo: 'ident', tipo: 'telefone', rotulo: 'Telefone (opcional)', exemplo: 'Ex.: (67) 99999-0000' },
    // relatório da visita
    { key: 'assunto', grupo: 'relatorio', tipo: 'voz', rotulo: 'O que foi tratado na visita', exemplo: 'Ex.: Apresentei o projeto de 6 pivôs; o cliente quer ajustar o valor', obrigatorio: true, max: 180 },
    { key: 'etapa', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Etapa do funil', opcoes: ETAPAS },
    // condicional: só aparece com etapa Ganho, Perdido ou Prospecção descartada (fica logo abaixo da etapa)
    { key: 'motivo', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Motivo', condicional: true, mostrarSe: { key: 'etapa', em: ['GANHO', 'PERDIDO', ETAPA_DESCARTADA] } },
    { key: 'probabilidade', grupo: 'relatorio', tipo: 'estrelas', rotulo: 'Probabilidade de compra' },
    { key: 'previsao_compra', grupo: 'relatorio', tipo: 'mes', rotulo: 'Previsão de compra' },
    { key: 'concorrente', grupo: 'relatorio', tipo: 'sim_nao', rotulo: 'Tem concorrente?' },
    { key: 'concorrente_nome', grupo: 'relatorio', tipo: 'voz', rotulo: 'Qual concorrente?', exemplo: 'Ex.: Bauer', max: 60, mostrarSe: { key: 'concorrente', igual: 'sim' } },
    { key: 'pagamento_tipo', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Pagamento', opcoes: asOpcoes(['Próprio', 'Financiado']) },
    { key: 'pagamento_detalhe', grupo: 'relatorio', tipo: 'voz', rotulo: 'Detalhe do pagamento', exemplo: 'Ex.: Financiamento BB, entrada de 20%', max: 90 },
    { key: 'proxima_acao', grupo: 'relatorio', tipo: 'voz', rotulo: 'Próxima ação', exemplo: 'Ex.: Voltar na sexta com o valor ajustado', obrigatorio: true, max: 90 },
    { key: 'proxima_acao_data', grupo: 'relatorio', tipo: 'data', rotulo: 'Data da próxima ação' },
    { key: 'observacoes', grupo: 'relatorio', tipo: 'voz', rotulo: 'Observações gerais (fale à vontade)', exemplo: 'Ex.: Cliente comparando com outra marca; decide depois da colheita', max: 300 },
    { key: 'tipo_sistema', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Tipo de sistema do projeto', opcoes: asOpcoes(TIPOS_SISTEMA), dica: 'Sem escolher, vale o do negócio (ou Pivô central).' },
    { key: 'pdf', grupo: 'relatorio', tipo: 'arquivo', rotulo: 'PDF do projeto (planilha do orçamento)' },
    // opcionais
    { key: 'segmentacao', grupo: 'opcional', tipo: 'multi', rotulo: 'Segmentação do cliente', opcoes: asOpcoes(SEGMENTOS) },
    { key: 'origem', grupo: 'opcional', tipo: 'opcoes', rotulo: 'Origem do contato', opcoes: asOpcoes(ORIGENS) },
    // legado (1.3.0): estimativas que saíram do formulário; o que já foi registrado continua aparecendo na ficha e no histórico
    { key: 'est_pivos', grupo: 'legado', tipo: 'voz', numero: true, rotulo: 'Nº de pivôs (estimativa)', exemplo: 'Diga só o número. Ex.: seis', max: 15 },
    { key: 'est_hectares', grupo: 'legado', tipo: 'voz', numero: true, rotulo: 'Hectares (estimativa)', exemplo: 'Diga só o número. Ex.: quatrocentos e cinquenta', max: 15 },
  ];

  const campoPorChave = (k) => CAMPOS.find((c) => c.key === k);
  const camposAudio = () => CAMPOS.filter((c) => c.tipo === 'voz' || c.tipo === 'texto_voz').map((c) => c.key);

  /** Motivos válidos para a etapa (lista de valores) ou null quando a etapa não tem motivo. */
  function motivosDaEtapa(etapa) {
    return etapa === 'GANHO' ? MOTIVOS_GANHO : etapa === 'PERDIDO' ? MOTIVOS_PERDA : etapa === ETAPA_DESCARTADA ? MOTIVOS_DESCARTE : null;
  }

  function opcoesDoCampo(def, valores) {
    if (def.key === 'motivo') return asOpcoes(motivosDaEtapa(valores && valores.etapa) || []);
    return def.opcoes || [];
  }

  function campoVisivel(def, valores) {
    const m = def.mostrarSe;
    if (!m) return true;
    const v = valores ? valores[m.key] : undefined;
    if (m.igual !== undefined) return v === m.igual;
    if (m.em) return m.em.indexOf(v) >= 0;
    return true;
  }

  /** Quantos campos aparecem na tela em cada cenário (usado nos testes e na tela de ajuda). */
  function contarCampos(o) {
    o = o || {};
    const base = CAMPOS.filter((c) => c.grupo === 'relatorio' && !c.condicional).length; // 13
    const ident = CAMPOS.filter((c) => c.grupo === 'ident').length; // 4
    return 1 + base + (o.prospect ? ident : 0) + (o.opcionais ? CAMPOS.filter((c) => c.grupo === 'opcional').length : 0) + (o.condicional ? 1 : 0);
  }

  /* ---------- nomes ---------- */
  function sanitizeNome(s) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const dois = (n) => (n < 10 ? '0' : '') + n;
  const fmtDataCurta = (d) => dois(d.getDate()) + MESES[d.getMonth()] + String(d.getFullYear()).slice(-2); // 24nov26
  const fmtHora = (d) => dois(d.getHours()) + dois(d.getMinutes()); // 1545

  /** "Vendedor - Cliente - Fazenda - Município - 24nov26 1545" */
  function nomeRelatorio(o) {
    const partes = [o.cliente, o.fazenda, o.municipio].map(sanitizeNome).filter(Boolean);
    const id = partes.length ? partes.join(' - ') : '(sem identificação)';
    const vend = sanitizeNome(o.vendedor) || '(sem vendedor)';
    const quando = fmtDataCurta(o.data) + ' ' + fmtHora(o.data);
    let nome = vend + ' - ' + id + ' - ' + quando;
    if (nome.length > 150) nome = vend + ' - ' + id.slice(0, 150 - vend.length - quando.length - 6) + ' - ' + quando;
    return nome;
  }

  function gerarCodigoProvisorio(data, rand) {
    const r = (rand || Math.random)();
    const sufixo = Math.floor(r * Math.pow(36, 5)).toString(36).toUpperCase().padStart(5, '0');
    return 'PRV-' + data.getFullYear() + dois(data.getMonth() + 1) + dois(data.getDate()) + '-' + sufixo;
  }

  function gerarId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return h() + h() + '-' + h() + '-' + h() + '-' + h() + '-' + h() + h() + h();
  }

  function extPorMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.indexOf('webm') >= 0) return 'webm';
    if (m.indexOf('ogg') >= 0) return 'ogg';
    if (m.indexOf('mp4') >= 0 || m.indexOf('aac') >= 0) return 'm4a';
    if (m.indexOf('mpeg') >= 0) return 'mp3';
    if (m.indexOf('wav') >= 0) return 'wav';
    return 'bin';
  }

  /** Telefone digitado: deixa só números e os símbolos usuais. */
  function limparTelefone(s) {
    return String(s == null ? '' : s).replace(/[^\d()+\-\s.]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ---------- data real da visita (registros antigos lançados pelo escritório no app, até a 1.2.0) ---------- */
  /** "2026-11-24" + "15:40" → { iso, semHora:false }. Sem hora → meio-dia local, semHora:true. Data inválida → null. */
  function dataHoraVisita(dataStr, horaStr) {
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dataStr || ''));
    if (!md) return null;
    const mh = /^(\d{2}):(\d{2})$/.exec(String(horaStr || ''));
    const semHora = !mh;
    const d = new Date(+md[1], +md[2] - 1, +md[3], mh ? +mh[1] : 12, mh ? +mh[2] : 0, 0, 0);
    if (isNaN(d.getTime()) || d.getFullYear() !== +md[1] || d.getMonth() !== +md[2] - 1 || d.getDate() !== +md[3]) return null;
    return { iso: d.toISOString(), semHora: semHora, data: d };
  }

  /** Quando a visita aconteceu (para ordenar): data real informada num lançamento antigo do escritório, senão a hora do salvamento. */
  const quandoDoRegistro = (r) => r.dataVisita || r.criadoEm;

  /* ---------- regra "a última visita sobrepõe; sem alteração mantém" ---------- */
  /** Junta os campos TOCADOS de várias visitas do mesmo negócio, da mais antiga para a mais nova.
   *  Valor null = apagado de propósito. Campo não tocado nunca aparece, então o valor anterior permanece. */
  function mesclarCampos(registros) {
    const ordenados = registros.slice().sort((a, b) => {
      const ta = Date.parse(quandoDoRegistro(a)), tb = Date.parse(quandoDoRegistro(b));
      return ta !== tb ? ta - tb : String(a.id).localeCompare(String(b.id));
    });
    const estado = {};
    ordenados.forEach((r) => {
      Object.keys(r.campos || {}).forEach((k) => {
        const v = r.campos[k];
        if (v === null) delete estado[k];
        else estado[k] = v;
      });
    });
    return estado;
  }

  /** Negócios conhecidos neste aparelho (pela ordem da última visita). */
  function listaNegocios(registros) {
    const mapa = {};
    registros
      .slice()
      .sort((a, b) => Date.parse(a.criadoEm) - Date.parse(b.criadoEm))
      .forEach((r) => {
        const n = mapa[r.negocioId] || (mapa[r.negocioId] = { id: r.negocioId, cliente: '', fazenda: '', municipio: '', ultimaVisita: r.criadoEm, provisorio: String(r.negocioId).indexOf('PRV-') === 0 });
        const ident = r.identificacao || {};
        if (ident.cliente) n.cliente = ident.cliente;
        if (ident.fazenda) n.fazenda = ident.fazenda;
        if (ident.municipio) n.municipio = ident.municipio;
        n.ultimaVisita = r.criadoEm;
      });
    return Object.keys(mapa)
      .map((k) => mapa[k])
      .sort((a, b) => Date.parse(b.ultimaVisita) - Date.parse(a.ultimaVisita));
  }

  function rotuloNegocio(n) {
    const partes = [n.cliente, n.fazenda].filter(Boolean).join(' — ');
    const base = partes || '(identificar no escritório)';
    return base + (n.municipio ? ' (' + n.municipio + ')' : '');
  }

  /* ---------- validação ----------
   * Obrigatórios: o negócio (e o nome do cliente, se for novo), o que foi tratado e a próxima ação (por voz).
   * Prospecção descartada: exige o motivo do descarte e dispensa a próxima ação (não há próximo passo).
   * d.valores = valores efetivos do negócio (o que já está nele + o que foi tocado agora); d.etapaTocada = a etapa foi escolhida NESTA visita
   * (padrão: sim). A etapa já gravada no negócio não trava uma visita nova. */
  function validarRegistro(d) {
    const erros = [];
    const v = d.valores || {};
    const textoCliente = d.texto && d.texto.cliente && d.texto.cliente.trim();
    const descarte = v.etapa === ETAPA_DESCARTADA && d.etapaTocada !== false;
    if (!d.negocioSel) erros.push('Escolha o negócio ou "Novo negócio".');
    else if (d.negocioSel === 'NOVO' && !textoCliente) erros.push('Digite o nome do cliente.');
    if (!(d.audios && d.audios.assunto)) erros.push('Grave o que foi tratado na visita.');
    if (descarte) {
      if (!v.motivo) erros.push('Escolha o motivo do descarte da prospecção.');
      else if (MOTIVOS_DESCARTE.indexOf(v.motivo) < 0) erros.push('O motivo escolhido não combina com "Prospecção descartada".');
    } else if (!(d.audios && d.audios.proxima_acao)) erros.push('Grave a próxima ação.');
    return erros;
  }

  /* ---------- utilidades de exibição ---------- */
  function fmtDur(seg) {
    const s = Math.max(0, Math.round(seg || 0));
    return Math.floor(s / 60) + ':' + dois(s % 60);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* =====================================================================
   * v1.2.0 — carteira no aparelho: negócios vindos do escritório, ficha só de leitura,
   * status das visitas, busca/filtros, ações vencidas e limpeza de áudio/PDF já liberados.
   * ===================================================================== */
  const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const mesmoVendedor = (a, b) => semAcento(String(a || '').replace(/\s+/g, ' ').trim()) === semAcento(String(b || '').replace(/\s+/g, ' ').trim()) && semAcento(a) !== '';
  const hojeIso = (d) => { d = d || new Date(); return d.getFullYear() + '-' + dois(d.getMonth() + 1) + '-' + dois(d.getDate()); };
  const ehNumero = (x) => typeof x === 'number' && isFinite(x);

  /** 'vencida' (antes de hoje), 'hoje' ou '' (futura / sem data). */
  function acaoVencida(data, hoje) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return '';
    const h = hoje || hojeIso();
    return data < h ? 'vencida' : data === h ? 'hoje' : '';
  }

  /** "2026-11-25 08:00" (hora de MS, como o escritório grava) ou ISO → milissegundos; 0 se não entender. */
  function parseQuando(s) {
    const t = Date.parse(String(s || '').trim().replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }
  const fmtDataBR = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(s || ''); };
  const fmtQuando = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] + (m[4] && String(s).length <= 16 ? ' ' + m[4] + ':' + m[5] : '') : String(s || ''); };
  const fmtNum = (n, casas) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas === undefined ? 2 : casas });
  const fmtReais = (n) => 'R$ ' + fmtNum(n, 2);

  /** R$/ha do projeto: o impresso no PDF; senão valor ÷ área. null se não der para calcular. */
  function valorPorHa(p) {
    if (!p) return null;
    if (ehNumero(p.rs_ha) && p.rs_ha > 0) return p.rs_ha;
    if (ehNumero(p.valor_total) && p.valor_total > 0 && ehNumero(p.area_ha) && p.area_ha > 0) return Math.round(p.valor_total / p.area_ha * 100) / 100;
    return null;
  }
  const temValorProjeto = (p) => !!p && ehNumero(p.valor_total) && p.valor_total > 0;

  const mapaLink = (gps) => (gps && ehNumero(Number(gps.lat)) && ehNumero(Number(gps.lng)) ? 'https://www.google.com/maps?q=' + Number(gps.lat).toFixed(6) + ',' + Number(gps.lng).toFixed(6) : '');

  function rotuloEtapa(v) { const e = ETAPAS.find((x) => x.v === v); return e ? e.t : String(v || ''); }

  /** Texto de um valor de campo para mostrar na ficha/histórico (somente leitura). */
  function textoCampo(def, v) {
    if (v === undefined || v === null || v === '') return '';
    if (def.tipo === 'estrelas') return '★ ' + v;
    if (def.tipo === 'sim_nao') return /^s/i.test(String(v)) ? 'Sim' : 'Não';
    if (def.tipo === 'mes') { const m = /^(\d{4})-(\d{2})/.exec(String(v)); return m ? m[2] + '/' + m[1] : String(v); }
    if (def.tipo === 'data') return fmtDataBR(v);
    if (def.tipo === 'multi') return Array.isArray(v) ? v.join(', ') : String(v);
    if (def.key === 'etapa') return rotuloEtapa(v);
    if (def.tipo === 'opcoes') { const o = (def.opcoes || []).find((x) => x.v === v); return o ? o.t : String(v); }
    return String(v);
  }

  /** Situação da visita para o vendedor: o que está no escritório manda; sem isso, o estado do envio. */
  function statusVisita(reg, sv) {
    if (sv) {
      if (sv.status === 'Liberada') return { codigo: 'liberada', texto: 'Liberada ✓', tom: 'ok' };
      if (sv.status === 'Rejeitada') return { codigo: 'rejeitada', texto: 'Rejeitada', tom: 'erro' };
      return { codigo: 'pendente', texto: 'Pendente no escritório', tom: 'atencao' };
    }
    if (reg && reg.status === 'enviado') return { codigo: 'processando', texto: 'Enviada — aguardando o escritório', tom: 'atencao' };
    if (reg && reg.status === 'enviando') return { codigo: 'enviando', texto: 'Enviando…', tom: 'atencao' };
    return { codigo: 'aguardando_envio', texto: 'Aguardando envio', tom: 'atencao' };
  }

  /** Só se exclui o que o escritório ainda não recebeu: registro salvo no aparelho e não transmitido (nem em transmissão). */
  const podeExcluirRegistro = (reg) => !!reg && reg.status === 'pendente';

  /** Áudio/PDF só saem do aparelho depois de: enviado + Liberada + o texto de CADA áudio já voltou (+ PDF copiado). */
  function podeLimparArquivos(reg, sv) {
    if (!reg || !sv || reg.limpo) return false;
    if (reg.status !== 'enviado' || sv.status !== 'Liberada') return false;
    const chaves = Object.keys(reg.audios || {});
    if (!chaves.length && !reg.pdf) return false;
    const temTexto = (v) => (typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== '');
    const textosOk = chaves.every((k) => { const def = campoPorChave(k); return def && def.grupo === 'ident' ? temTexto(sv[k]) : temTexto((sv.campos || {})[k]); });
    if (!textosOk) return false;
    if (reg.pdf && !sv.pdf_ok) return false;
    return true;
  }

  /**
   * Negócios do aparelho = os que o escritório mandou (carteira) + os criados/atualizados aqui que o escritório ainda não devolveu.
   * Visita com id provisório (PRV-…) já ligada a outro negócio no escritório entra no negócio oficial.
   * "campos" = o que o escritório tem + o que foi registrado aqui e ainda não voltou da planilha.
   */
  function unirNegocios(registros, srvNegocios, srvVisitas) {
    const sv = {}, alias = {}, srvPorId = {}, itens = {};
    (srvVisitas || []).forEach((v) => { sv[v.id] = v; if (v.negocio_app && v.negocio && v.negocio_app !== v.negocio) alias[v.negocio_app] = v.negocio; });
    (srvNegocios || []).forEach((n) => { srvPorId[n.id] = n; });
    (srvNegocios || []).forEach((n) => {
      itens[n.id] = { id: n.id, cliente: n.cliente || '', fazenda: n.fazenda || '', municipio: n.municipio || '', telefone: n.telefone || '', gps: n.gps || null,
        campos: Object.assign({}, n.campos || {}), projeto: n.projeto || null, historico: n.historico || [], nVisitas: n.n_visitas || 0, primeira: n.primeira || '', ultima: n.ultima || '',
        srv: true, provisorio: false, regs: [], ultimaMs: parseQuando(n.ultima) };
    });
    registros.slice().sort((a, b) => Date.parse(a.criadoEm) - Date.parse(b.criadoEm)).forEach((r) => {
      const id = alias[r.negocioId] && srvPorId[alias[r.negocioId]] ? alias[r.negocioId] : r.negocioId;
      const it = itens[id] || (itens[id] = { id, cliente: '', fazenda: '', municipio: '', telefone: '', gps: null, campos: {}, projeto: null, historico: [], nVisitas: 0, primeira: '', ultima: '',
        srv: false, provisorio: String(id).indexOf('PRV-') === 0, regs: [], ultimaMs: 0 });
      it.regs.push(r);
      if (!it.srv) {
        const ident = r.identificacao || {};
        ['cliente', 'fazenda', 'municipio', 'telefone'].forEach((k) => { if (ident[k]) it[k] = ident[k]; });
        if (r.gps && !it.gps) it.gps = { lat: r.gps.lat, lng: r.gps.lng, prec: r.gps.acuraciaM };
      }
      it.ultimaMs = Math.max(it.ultimaMs, Date.parse(r.criadoEm) || 0);
    });
    Object.keys(itens).forEach((id) => {
      const it = itens[id];
      const aplicar = it.srv ? it.regs.filter((r) => !sv[r.id]) : it.regs; // o que a planilha já refletiu não se aplica de novo
      aplicar.slice().sort((a, b) => Date.parse(quandoDoRegistro(a)) - Date.parse(quandoDoRegistro(b))).forEach((r) => {
        Object.keys(r.campos || {}).forEach((k) => { if (r.campos[k] === null) delete it.campos[k]; else it.campos[k] = r.campos[k]; });
        const tel = r.identificacao && r.identificacao.telefone;
        if (tel) it.telefone = tel;
      });
      it.naoLiberadas = it.regs.filter((r) => !sv[r.id] || sv[r.id].status !== 'Liberada');
    });
    return Object.keys(itens).map((k) => itens[k]).sort((a, b) => b.ultimaMs - a.ultimaMs);
  }

  /** Busca (cliente, fazenda, município, telefone) + filtros de município, etapa e "ação vencida ou de hoje". */
  function filtrarNegocios(lista, f, hoje) {
    f = f || {};
    const termos = semAcento(f.busca || '').split(/\s+/).filter(Boolean);
    return lista.filter((n) => {
      if (f.municipio && semAcento(n.municipio) !== semAcento(f.municipio)) return false;
      if (f.etapa && (n.campos || {}).etapa !== f.etapa) return false;
      if (f.vencidas && !acaoVencida((n.campos || {}).proxima_acao_data, hoje)) return false;
      if (termos.length) {
        const palha = semAcento([n.cliente, n.fazenda, n.municipio, n.telefone, String(n.telefone || '').replace(/\D/g, '')].join(' '));
        if (!termos.every((t) => palha.indexOf(t) >= 0)) return false;
      }
      return true;
    });
  }
  const municipiosDisponiveis = (lista) => {
    const m = {};
    lista.forEach((n) => { if (n.municipio) m[semAcento(n.municipio)] = n.municipio; });
    return Object.keys(m).sort().map((k) => m[k]);
  };
  /** Etapas que existem na lista, na ordem do funil; etapas desconhecidas (vindas do CRM antigo) entram no fim. */
  const etapasDisponiveis = (lista) => {
    const usadas = {};
    lista.forEach((n) => { const e = (n.campos || {}).etapa; if (e) usadas[e] = true; });
    const conhecidas = ETAPAS.filter((e) => usadas[e.v]).map((e) => ({ v: e.v, t: e.t }));
    const extras = Object.keys(usadas).filter((v) => !ETAPAS.some((e) => e.v === v)).sort().map((v) => ({ v, t: v }));
    return conhecidas.concat(extras);
  };
  /** Ações com data vencida ou de hoje: as vencidas primeiro, da mais antiga para a mais nova. */
  const acoesVencidas = (lista, hoje) => lista
    .map((n) => ({ n, estado: acaoVencida((n.campos || {}).proxima_acao_data, hoje) }))
    .filter((x) => x.estado)
    .sort((a, b) => String(a.n.campos.proxima_acao_data).localeCompare(String(b.n.campos.proxima_acao_data)));

  /* =====================================================================
   * v1.3.0 — avisos de alteração: quando o escritório/administrador altera algo do negócio do vendedor,
   * o celular mostra o aviso até o vendedor dar "Ciente" (a ciência fica só neste aparelho).
   * ===================================================================== */
  const ROTULO_ACAO_AVISO = {
    'editou visita': 'editou uma visita',
    'lançou visita': 'lançou uma visita em seu nome',
    'anexou PDF': 'anexou o PDF do projeto',
    'rejeitou visita': 'rejeitou uma visita',
    'excluiu visita': 'excluiu uma visita',
    'corrigiu identificação': 'corrigiu a identificação do negócio',
  };

  /** Avisos que o vendedor ainda não deu ciência, do mais novo para o mais antigo. vistos = { idDoAviso: true }. */
  function avisosPendentes(avisos, vistos) {
    vistos = vistos || {};
    return (Array.isArray(avisos) ? avisos : [])
      .filter((a) => a && a.id && !vistos[a.id])
      .sort((a, b) => (Date.parse(b.quando) || 0) - (Date.parse(a.quando) || 0));
  }

  /** Avisos que dizem respeito a um negócio do aparelho (casa pelo id oficial, pelo provisório ou pelas visitas dele). */
  function avisosDoNegocio(avisos, n) {
    if (!n) return [];
    const ids = {};
    ids[n.id] = true;
    (n.regs || []).forEach((r) => { if (r.negocioId) ids[r.negocioId] = true; });
    return avisos.filter((a) => ids[a.negocio] || (Array.isArray(a.ids) && a.ids.some((i) => ids[i])));
  }

  /** "25/11/2026 10:34" no fuso do aparelho, a partir do instante ISO do aviso. */
  function quandoAviso(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return dois(d.getDate()) + '/' + dois(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + dois(d.getHours()) + ':' + dois(d.getMinutes());
  }

  /** { titulo, quando, detalhe } para mostrar. */
  function textoAviso(a) {
    const quem = a && a.por === 'Administrador' ? 'O administrador' : 'O escritório';
    const acao = ROTULO_ACAO_AVISO[a && a.acao] || String((a && a.acao) || 'alterou o negócio');
    return { titulo: quem + ' ' + acao, quando: quandoAviso(a && a.quando), detalhe: String((a && a.resumo) || '') };
  }

  return {
    APP_VERSAO, CAMPOS, ETAPAS, ETAPA_PROSPECCAO, ETAPA_DESCARTADA, MOTIVOS_GANHO, MOTIVOS_PERDA, MOTIVOS_DESCARTE, ORIGENS, SEGMENTOS, TIPOS_SISTEMA,
    campoPorChave, camposAudio, motivosDaEtapa, opcoesDoCampo, campoVisivel, contarCampos,
    sanitizeNome, fmtDataCurta, fmtHora, nomeRelatorio, gerarCodigoProvisorio, gerarId, extPorMime,
    limparTelefone, dataHoraVisita, quandoDoRegistro,
    mesclarCampos, listaNegocios, rotuloNegocio, validarRegistro, fmtDur, fmtBytes,
    semAcento, mesmoVendedor, hojeIso, acaoVencida, parseQuando, fmtDataBR, fmtQuando, fmtNum, fmtReais, valorPorHa, temValorProjeto, mapaLink, rotuloEtapa, textoCampo,
    statusVisita, podeExcluirRegistro, podeLimparArquivos, unirNegocios, filtrarNegocios, municipiosDisponiveis, etapasDisponiveis, acoesVencidas,
    avisosPendentes, avisosDoNegocio, quandoAviso, textoAviso,
  };
});
