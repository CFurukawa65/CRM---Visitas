/* logic.js — regras puras do app CRM Visitas (sem DOM).
 * Roda no navegador (window.Logic) e no node (module.exports), para poder ser testado. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const APP_VERSAO = '1.1.0';
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  /* ---------- listas fechadas (vindas do CRM atual) ---------- */
  // GANHO / PERDIDO / 0-Arquivado: o escritório converte para a etapa/conclusão do CRM atual.
  const ETAPAS = [
    { v: '1-Oportunidade Mapeada', t: 'Oportunidade mapeada' },
    { v: '5-Projeto Pronto', t: 'Projeto pronto' },
    { v: '6-Apresentação realizada', t: 'Apresentação realizada' },
    { v: '3-Negociando', t: 'Negociando' },
    { v: 'GANHO', t: 'Ganho (fechou)' },
    { v: 'PERDIDO', t: 'Perdido' },
    { v: '0-Arquivado', t: 'Arquivar' },
  ];
  const MOTIVOS_GANHO = ['Parcelamento RP', 'Preferência pela Marca', 'Qualidade de Projeto', 'Preço', 'Condições de Pagamento', 'Prazo de Entrega'];
  const MOTIVOS_PERDA = ['Preço', 'Problema de relacionamento', 'Preferência por Marca', 'Falta de Atendimento'];
  const ORIGENS = ['Carteira de vendas', 'Indicação de parceiros', 'Canais Digitais', 'Eventos', 'Campanha Fábrica', 'Marketing'];
  const SEGMENTOS = ['Grãos', 'Pecuária', 'Cana'];
  const TIPOS_SISTEMA = ['Pivô central', 'Carretel', 'Aspersão', 'Outro'];

  const asOpcoes = (arr) => arr.map((x) => ({ v: x, t: x }));

  /* ---------- definição dos campos ----------
   * tipo: texto_voz | texto | telefone | voz | opcoes | estrelas | mes | data | sim_nao | multi | arquivo
   * max: duração máxima da gravação (s). obrigatorio: exige preenchimento para salvar.
   * numero: o campo dita só o número (o escritório grava como número). */
  const CAMPOS = [
    // identificação (só "Novo prospect"): digitado OU por voz; telefone sempre digitado e opcional
    { key: 'cliente', grupo: 'ident', tipo: 'texto_voz', rotulo: 'Nome do cliente', exemplo: 'Ex.: Valdemir Rossini', max: 30 },
    { key: 'fazenda', grupo: 'ident', tipo: 'texto_voz', rotulo: 'Fazenda', exemplo: 'Ex.: Fazenda Samambaia', max: 30 },
    { key: 'municipio', grupo: 'ident', tipo: 'texto_voz', rotulo: 'Município', exemplo: 'Ex.: Batayporã', max: 30 },
    { key: 'telefone', grupo: 'ident', tipo: 'telefone', rotulo: 'Telefone (opcional)', exemplo: 'Ex.: (67) 99999-0000' },
    // relatório da visita
    { key: 'assunto', grupo: 'relatorio', tipo: 'voz', rotulo: 'O que foi tratado na visita', exemplo: 'Ex.: Apresentei o projeto de 6 pivôs; o cliente quer ajustar o valor', obrigatorio: true, max: 180 },
    { key: 'etapa', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Etapa do funil', opcoes: ETAPAS },
    // condicional: só aparece com etapa Ganho/Perdido (fica logo abaixo da etapa)
    { key: 'motivo', grupo: 'relatorio', tipo: 'opcoes', rotulo: 'Motivo', condicional: true, mostrarSe: { key: 'etapa', em: ['GANHO', 'PERDIDO'] } },
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
    { key: 'est_pivos', grupo: 'opcional', tipo: 'voz', numero: true, rotulo: 'Nº de pivôs (estimativa)', exemplo: 'Diga só o número. Ex.: seis', max: 15 },
    { key: 'est_hectares', grupo: 'opcional', tipo: 'voz', numero: true, rotulo: 'Hectares (estimativa)', exemplo: 'Diga só o número. Ex.: quatrocentos e cinquenta', max: 15 },
  ];

  const campoPorChave = (k) => CAMPOS.find((c) => c.key === k);
  const camposAudio = () => CAMPOS.filter((c) => c.tipo === 'voz' || c.tipo === 'texto_voz').map((c) => c.key);

  function opcoesDoCampo(def, valores) {
    if (def.key === 'motivo') {
      const etapa = valores && valores.etapa;
      return asOpcoes(etapa === 'GANHO' ? MOTIVOS_GANHO : etapa === 'PERDIDO' ? MOTIVOS_PERDA : []);
    }
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

  /* ---------- lançamento do escritório: data (e hora, opcional) real da visita ---------- */
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

  /** Quando a visita aconteceu (para ordenar): data real informada no lançamento do escritório, senão a hora do salvamento. */
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

  /* ---------- validação: só 3 itens são obrigatórios (no lançamento do escritório, mais a data e o vendedor) ---------- */
  function validarRegistro(d, hoje) {
    const erros = [];
    const textoCliente = d.texto && d.texto.cliente && d.texto.cliente.trim();
    if (!d.negocioSel) erros.push('Escolha o negócio ou "Novo prospect".');
    else if (d.negocioSel === 'NOVO' && !textoCliente && !(d.audios && d.audios.cliente)) erros.push('Informe o nome do cliente (digitado ou por voz).');
    if (!(d.audios && d.audios.assunto)) erros.push('Grave o que foi tratado na visita.');
    if (!(d.audios && d.audios.proxima_acao)) erros.push('Grave a próxima ação.');
    if (d.modo === 'escritorio') {
      if (!String(d.lancandoEm || '').trim()) erros.push('Informe em nome de qual vendedor está lançando.');
      const dh = dataHoraVisita(d.dataVisita, d.horaVisita);
      if (!dh) erros.push('Informe a data em que a visita aconteceu.');
      else if (dh.data.getTime() > (hoje || new Date()).getTime() + 24 * 3600 * 1000) erros.push('A data da visita está no futuro.');
    }
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

  return {
    APP_VERSAO, CAMPOS, ETAPAS, MOTIVOS_GANHO, MOTIVOS_PERDA, ORIGENS, SEGMENTOS, TIPOS_SISTEMA,
    campoPorChave, camposAudio, opcoesDoCampo, campoVisivel, contarCampos,
    sanitizeNome, fmtDataCurta, fmtHora, nomeRelatorio, gerarCodigoProvisorio, gerarId, extPorMime,
    limparTelefone, dataHoraVisita, quandoDoRegistro,
    mesclarCampos, listaNegocios, rotuloNegocio, validarRegistro, fmtDur, fmtBytes,
  };
});
