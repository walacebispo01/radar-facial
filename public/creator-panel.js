(function () {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el; };
  const state = { me: null, commissionPage: 1, creatorPage: 1, networkPage: 1, networkId: '', keys: new Map(), requestVersions: new Map() };
  const currency = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 6 });
  const date = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
  const labels = { ativo: 'Ativo', suspenso: 'Suspenso', approved: 'Aprovado', pending: 'Pendente', refunded: 'Reembolsado', cancelled: 'Cancelado', vendedor: 'Vendedor', indicador: 'Indicador direto', inicial: 'Criador inicial', demais: 'Demais níveis', comissao: 'Comissão', estorno: 'Estorno', partial: 'Parcial', full: 'Integral' };
  const label = value => labels[value] || (String(value).startsWith('nivel_') ? 'Nível ' + String(value).slice(6) : value) || '—';
  const auth = window.RadarAuth.createClient({ onSession(session) { if (!session) { state.me = null; $('#app').hidden = true; $('#entry').hidden = false; $('#logout').hidden = true; $('#identity').textContent = 'Acesso com conta cadastrada'; if ($('#detail').open) $('#detail').close(); } } });

  function notice(message, error = false) { const el = $('#notice'); el.textContent = message; el.hidden = !message; el.className = error ? 'error' : ''; }
  function unlock() { $('#stepup').hidden = false; state.restoreDetail = $('#detail').open; if ($('#detail').open) $('#detail').close(); $('#stepup').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#totp').focus(); }
  async function api(path, { method = 'GET', body, key } = {}) {
    const response = await auth.request('/api/programa' + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      if (data.code === 'STEP_UP_REQUIRED') unlock();
      throw new Error(data.code === 'STEP_UP_REQUIRED' ? 'Confirme o código do autenticador acima e tente salvar novamente.' : (data.error || data.message || 'Não foi possível concluir. Tente novamente.'));
    }
    return data;
  }
  async function legacyApi(path, { body } = {}) {
    const response = await auth.request('/api/admin/simulacao' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) { if (data.code === 'STEP_UP_REQUIRED') unlock(); throw new Error(data.code === 'STEP_UP_REQUIRED' ? 'Confirme o código do autenticador acima e tente novamente.' : (data.error || 'Não foi possível concluir.')); }
    return data;
  }
  function values(form) { return Object.fromEntries(new FormData(form)); }
  function query(data) { const params = new URLSearchParams(); Object.entries(data).forEach(([key, value]) => { if (value !== '' && value != null) params.set(key, value); }); return '?' + params.toString(); }
  function button(text, action, className = 'quiet') { const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', () => Promise.resolve().then(action).catch(error => notice(error.message, true))); return el; }
  function table(target, rows, columns) {
    target.replaceChildren();
    if (!rows.length) { target.append(node('p', 'Nenhum registro encontrado para estes filtros.', 'empty')); return; }
    const tbl = node('table'); const head = node('thead'); const hr = node('tr'); columns.forEach(col => hr.append(node('th', col.title))); head.append(hr); tbl.append(head); const body = node('tbody');
    rows.forEach(row => { const tr = node('tr'); columns.forEach(col => { const td = node('td'); td.dataset.label = col.title; const value = col.value(row); td.append(value instanceof Node ? value : node('span', value == null ? '—' : value)); tr.append(td); }); body.append(tr); }); tbl.append(body); target.append(tbl);
  }
  function pagination(target, data, current, navigate, defaultSize = 30) {
    target.replaceChildren(); const page = Number(data.page || current); const total = Number(data.total || 0); const size = Number(data.pageSize || data.page_size || defaultSize);
    const prev = button('Anterior', () => navigate(page - 1)); prev.disabled = page <= 1; const next = button('Próxima', () => navigate(page + 1)); next.disabled = data.hasMore != null ? !data.hasMore : (page * size >= total);
    target.append(prev, node('span', 'Página ' + page + ' · ' + total + ' registros'), next);
  }
  async function load(target, action) {
    const version = (state.requestVersions.get(target) || 0) + 1; state.requestVersions.set(target, version);
    target.setAttribute('aria-busy', 'true'); target.replaceChildren(node('p', 'Carregando…', 'empty'));
    try { const render = await action(); if (state.requestVersions.get(target) === version && state.me) render(); }
    catch (error) { if (state.requestVersions.get(target) === version) target.replaceChildren(node('p', error.message, 'empty')); }
    finally { if (state.requestVersions.get(target) === version) target.removeAttribute('aria-busy'); }
  }
  function bindForm(form, handler) {
    form.addEventListener('submit', async event => { event.preventDefault(); const submit = form.querySelector('[type=submit]') || form.querySelector('button'); const status = form.querySelector('.form-status'); if (submit.disabled) return; submit.disabled = true;
      if (status) { status.textContent = 'Salvando…'; status.classList.remove('error'); }
      try { await handler(values(form)); if (status) status.textContent = 'Salvo com sucesso.'; }
      catch (error) { if (status) { status.textContent = error.message; status.classList.add('error'); } else notice(error.message, true); }
      finally { submit.disabled = false; }
    });
  }
  function detail(title) { $('#detail-title').textContent = title; $('#detail-body').replaceChildren(); if (!$('#detail').open) $('#detail').showModal(); return $('#detail-body'); }
  function fields(parent, entries) { const dl = node('dl'); entries.forEach(([key, value]) => { dl.append(node('dt', key), node('dd', value == null ? '—' : value)); }); parent.append(dl); }
  function safeURL(raw) { try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
  function inputField(form, title, name, value, type = 'text', opts = {}) { const wrap = node('label', title); const input = node('input'); Object.assign(input, { name, type, value: value ?? '' }, opts); wrap.append(input); form.append(wrap); return input; }

  async function commissions(page = 1) {
    state.commissionPage = page;
    await load($('#commission-list'), async () => {
      const filters = values($('#commission-filters'));
      if (filters.from && filters.to && filters.from > filters.to) throw new Error('A data inicial precisa ser anterior ou igual à data final.');
      const data = await api('/comissoes' + query({ ...filters, page }));
      return () => {
        const totals = data.totals || {}; $('#metrics').replaceChildren();
        [['Comissão original', totals.comissao], ['Estornos', totals.estorno], ['Comissão líquida', totals.saldo]].forEach(([title, amount]) => { const card = node('div', null, 'metric'); card.append(node('span', title), node('strong', currency(amount))); $('#metrics').append(card); });
        table($('#commission-list'), data.items || [], [
          { title: 'Pagamento', value: row => button(row.payment_id, () => paymentDetail(row.payment_id)) },
          { title: 'Data', value: row => date(row.criado_em) },
          { title: 'Criador', value: row => row.criador_nome || row.criador_id || 'Sem beneficiário' },
          { title: 'Parcela', value: row => label(row.parcela) },
          { title: 'Tipo', value: row => label(row.tipo) },
          { title: 'Nível', value: row => row.nivel ?? '—' },
          { title: 'Valor', value: row => currency(row.valor) },
          { title: 'Status', value: row => label(row.status) }
        ]);
        pagination($('#commission-pages'), data, page, commissions, 20);
      };
    });
  }
  async function paymentDetail(id) {
    const body = detail('Pagamento ' + id); body.append(node('p', 'Carregando…'));
    try {
      const data = await api('/comissoes/' + encodeURIComponent(id)); body.replaceChildren(); const payment = data.payment || {};
      fields(body, [['ID Mercado Pago', payment.payment_id || id], ['Status', label(payment.status)], ['Valor da venda', currency(payment.valor_pago)], ['Data', date(payment.criado_em)]]);
      body.append(node('h3', 'Distribuição da comissão')); const allocations = node('div', null, 'results'); body.append(allocations);
      table(allocations, data.allocations || [], [{ title: 'Criador', value: row => row.criador_nome || row.criador_id || 'Sem beneficiário' }, { title: 'Parcela', value: row => label(row.parcela) }, { title: 'Tipo', value: row => label(row.tipo) }, { title: 'Nível', value: row => row.nivel }, { title: 'Valor', value: row => currency(row.valor) }]);
      body.append(node('h3', 'Histórico de reembolsos', 'detail-section')); const refunds = node('div', null, 'results'); body.append(refunds);
      table(refunds, data.refunds || [], [{ title: 'ID', value: row => row.refund_id || row.id }, { title: 'Data', value: row => date(row.criado_em) }, { title: 'Valor', value: row => currency(row.valor) }, { title: 'Status', value: row => label(row.status) }]);
    } catch (error) { body.replaceChildren(node('p', error.message)); }
  }
  async function creators(page = 1) {
    state.creatorPage = page;
    await load($('#creator-list'), async () => { const data = await api('/admin/criadores' + query({ ...values($('#creator-filters')), page })); return () => {
      table($('#creator-list'), data.items || [], [{ title: 'Nome', value: row => row.nome }, { title: 'E-mail', value: row => row.email }, { title: 'Comissão-base', value: row => row.percentual + '%' }, { title: 'Status', value: row => label(row.status) }, { title: 'Gravação', value: row => row.demo_enabled ? 'Liberada' : 'Bloqueada' }, { title: 'Ações', value: row => button('Gerenciar', () => manageCreator(row)) }]); pagination($('#creator-pages'), data, page, creators);
    }; });
    await simulationAccess();
  }
  async function simulationAccess() {
    await load($('#simulation-access-list'), async () => { const data = await legacyApi('/listar'); return () => table($('#simulation-access-list'), data.criadores || [], [
      { title: 'E-mail', value: row => row.email }, { title: 'Links', value: row => (row.links || []).length },
      { title: 'Ação', value: row => button('Remover', async () => { await legacyApi('/remover', { body: { email: row.email } }); await simulationAccess(); }) }
    ]); });
  }
  function manageCreator(creator) {
    const body = detail(creator.nome || creator.email); fields(body, [['ID', creator.id], ['E-mail', creator.email], ['Código de indicação', creator.afiliado_codigo], ['Indicador', creator.parent_id], ['Nível', creator.depth]]);
    const form = node('form', null, 'stack'); body.append(form); inputField(form, 'Nome', 'nome', creator.nome, 'text', { required: true, maxLength: 120 }); inputField(form, 'Comissão-base (%) nas próximas vendas', 'percentual', creator.percentual, 'number', { min: '0', max: '30', step: '0.01', required: true });
    const statusWrap = node('label', 'Status'); const select = node('select'); select.name = 'status'; [['ativo', 'Ativo'], ['suspenso', 'Suspenso']].forEach(([value, title]) => { const option = node('option', title); option.value = value; select.append(option); }); select.value = creator.status; statusWrap.append(select); form.append(statusWrap);
    const demoLabel = node('label', null, 'check'); const check = node('input'); Object.assign(check, { name: 'demo_enabled', type: 'checkbox', checked: !!creator.demo_enabled }); demoLabel.append(check, node('span', 'Liberar cenários de gravação')); form.append(demoLabel); inputField(form, 'Motivo da alteração', 'motivo', '', 'text', { required: true, maxLength: 500 }); const save = node('button', 'Salvar alterações'); save.type = 'submit'; form.append(save, node('p', '', 'form-status'));
    bindForm(form, async data => { await api('/admin/criadores/' + encodeURIComponent(creator.id), { method: 'PATCH', body: { ...data, percentual: Number(data.percentual), demo_enabled: check.checked } }); await creators(state.creatorPage); });
    body.append(node('h3', 'Liberar créditos', 'detail-section')); const credits = node('form', null, 'stack'); body.append(credits); inputField(credits, 'Quantidade', 'quantidade', '', 'number', { required: true, min: '1', step: '1' }); inputField(credits, 'Motivo da liberação', 'motivo', '', 'text', { required: true, maxLength: 500 }); const grant = node('button', 'Liberar créditos'); grant.type = 'submit'; credits.append(grant, node('p', '', 'form-status'));
    bindForm(credits, async data => {
      const payload = { quantidade: Number(data.quantidade), motivo: data.motivo }; const operation = JSON.stringify([creator.id, payload]); if (!state.keys.has(operation)) state.keys.set(operation, crypto.randomUUID());
      const result = await api('/admin/criadores/' + encodeURIComponent(creator.id) + '/creditos', { method: 'POST', body: payload, key: state.keys.get(operation) });
      credits.reset(); state.keys.delete(operation); notice('Créditos liberados. Saldo: ' + (result.creditos ?? 'atualizado') + '.');
    });
    const actions = node('div', null, 'actions detail-section'); actions.append(button('Ver histórico', () => history(creator)), button('Ver rede', async () => { $('#detail').close(); state.networkId = creator.id; $('#network-filter input').value = creator.id; await activate('network'); })); body.append(actions);
  }
  async function history(creator) {
    const body = detail('Histórico · ' + (creator.nome || creator.email)); body.append(node('p', 'Carregando…'));
    try { const data = await api('/admin/criadores/' + encodeURIComponent(creator.id) + '/historico'); body.replaceChildren(); body.append(node('h3', 'Créditos liberados')); const grants = node('div', null, 'results'); body.append(grants); table(grants, data.grants || [], [{ title: 'Data', value: row => date(row.criado_em) }, { title: 'Quantidade', value: row => row.quantidade }, { title: 'Saldo após', value: row => row.saldo_depois }, { title: 'Motivo', value: row => row.motivo }, { title: 'Responsável', value: row => row.ator }]); body.append(node('h3', 'Alterações administrativas', 'detail-section')); const audit = node('div', null, 'results'); body.append(audit); table(audit, data.audit || [], [{ title: 'Data', value: row => date(row.criado_em) }, { title: 'Ação', value: row => row.acao }, { title: 'Motivo', value: row => row.motivo }, { title: 'Responsável', value: row => row.ator }]);
      body.append(node('h3', 'Histórico de gravações', 'detail-section')); const simulations = node('div', null, 'results'); body.append(simulations); table(simulations, data.simulations || [], [{ title: 'Data', value: row => date(row.criado_em) }, { title: 'Cenário', value: row => row.cenario_id }, { title: 'Execução', value: row => row.id }]); }
    catch (error) { body.replaceChildren(node('p', error.message)); }
  }
  async function network(page = 1) {
    state.networkPage = page;
    if (!state.networkId) { $('#network-list').replaceChildren(node('p', 'Informe o ID de um criador para consultar a rede.', 'empty')); return; }
    await load($('#network-list'), async () => { const data = await api('/rede/' + encodeURIComponent(state.networkId) + query({ page })); return () => {
      table($('#network-list'), data.items || [], [{ title: 'Nome', value: row => row.nome }, { title: 'ID', value: row => row.id }, { title: 'Indicador', value: row => row.parent_id }, { title: 'Nível', value: row => row.level ?? row.depth }, { title: 'Status', value: row => label(row.status) }, { title: 'Rede', value: row => button('Ver indicados', async () => { state.networkId = row.id; $('#network-filter input').value = row.id; await network(); }) }]);
      const trail = node('div', null, 'actions'); (data.path || []).forEach(item => trail.append(button(item.nome || item.id, async () => { state.networkId = item.id; $('#network-filter input').value = item.id; await network(); }))); if (trail.childElementCount) $('#network-list').prepend(trail); if (data.creator) $('#network-list').prepend(node('h3', 'Indicados por ' + data.creator.nome)); pagination($('#network-pages'), data, page, network);
    }; });
  }
  async function scenarios() {
    await load($('#scenario-list'), async () => { const data = await api('/cenarios'); return () => { const list = $('#scenario-list'); list.replaceChildren(); if (!data.items?.length) list.append(node('p', 'Salve seu primeiro cenário para preparar uma gravação.', 'empty')); (data.items || []).forEach(scenario => { const card = node('article', null, 'surface'); card.append(node('h3', scenario.nome), node('p', (scenario.links?.length || 0) + ' links · ' + date(scenario.atualizado_em || scenario.criado_em), 'muted')); const actions = node('div', null, 'actions'); actions.append(button('Editar', () => { const form = $('#scenario-form'); form.elements.id.value = scenario.id; form.elements.nome.value = scenario.nome; form.elements.links.value = (scenario.links || []).map(item => item.url).join('\n'); form.scrollIntoView({ behavior: 'smooth' }); form.elements.nome.focus(); })); const recording = node('a', 'Preparar gravação', 'button'); recording.href = '/?cenario=' + encodeURIComponent(scenario.id); actions.append(recording); card.append(actions); list.append(card); }); }; });
  }
  async function activate(tab) {
    if (!state.me || (tab === 'creators' && !state.me.isAdmin) || (tab === 'scenarios' && !(state.me.creator?.demo_enabled && state.me.creator.status === 'ativo'))) return;
    document.querySelectorAll('.tab-section').forEach(section => { section.hidden = section.id !== tab; }); document.querySelectorAll('[data-tab]').forEach(item => { if (item.dataset.tab === tab) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    await ({ commissions, creators, network, scenarios })[tab]();
  }
  $('#close-detail').addEventListener('click', () => $('#detail').close());
  $('#logout').addEventListener('click', () => auth.logout().catch(error => notice(error.message, true)));
  document.querySelectorAll('[data-tab]').forEach(item => item.addEventListener('click', () => activate(item.dataset.tab)));
  bindForm($('#unlock-form'), async data => { await api('/admin/verificar', { method: 'POST', body: data }); $('#unlock-form').reset(); $('#stepup').hidden = true; if (state.restoreDetail) { $('#detail').showModal(); state.restoreDetail = false; } notice('Acesso administrativo confirmado por 5 minutos. Você pode salvar sua alteração.'); });
  bindForm($('#commission-filters'), () => commissions()); $('#commission-filters').addEventListener('reset', () => setTimeout(() => commissions(), 0));
  bindForm($('#creator-filters'), () => creators());
  bindForm($('#network-filter'), async data => { state.networkId = data.id.trim(); await network(); });
  bindForm($('#creator-form'), async data => { await api('/admin/criadores', { method: 'POST', body: { ...data, parent_id: data.parent_id.trim() || null, percentual: Number(data.percentual), demo_enabled: $('#creator-form').elements.demo_enabled.checked } }); $('#creator-form').reset(); await creators(); });
  bindForm($('#simulation-access-form'), async data => { await legacyApi('/autorizar', { body: { email: data.email } }); $('#simulation-access-form').reset(); await simulationAccess(); });
  bindForm($('#scenario-form'), async data => { const urls = data.links.split(/\r?\n/).map(line => line.trim()).filter(Boolean); if (!urls.length || urls.some(url => !safeURL(url))) throw new Error('Informe links válidos que comecem com https:// ou http://, um por linha.'); await api('/cenarios', { method: 'POST', body: { ...(data.id ? { id: data.id } : {}), nome: data.nome, links: urls.map(url => ({ url })) } }); $('#scenario-form').reset(); await scenarios(); });

  (async () => {
    try {
      const session = await auth.restore(); if (!session) return;
      const data = await api('/me'); state.me = data;
      if (!data.isAdmin && (!data.creator || data.creator.status !== 'ativo')) { $('#identity').textContent = 'Sua conta não possui acesso ativo ao programa de criadores.'; $('#logout').hidden = false; return; }
      $('#app').hidden = false; $('#entry').hidden = true; $('#logout').hidden = false; $('#identity').textContent = data.isAdmin ? 'Administração · acesso protegido' : (data.creator.nome || data.creator.email) + ' · Código ' + data.creator.afiliado_codigo;
      $('[data-tab=creators]').hidden = !data.isAdmin; $('#commission-creator-filter').hidden = !data.isAdmin; $('[data-tab=scenarios]').hidden = !(data.creator?.demo_enabled && data.creator.status === 'ativo'); $('#network-filter').hidden = !data.isAdmin;
      state.networkId = data.creator?.id || ''; $('#network-filter input').value = state.networkId;
      await commissions();
    } catch (error) { $('#identity').textContent = 'Não foi possível abrir o painel.'; notice(error.message, true); }
  })();
})();
