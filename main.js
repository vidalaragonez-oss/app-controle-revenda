/**
 * Vidal Beauty — Controle de Vendas
 * Gerenciamento de boletos, parcelas e cálculos financeiros.
 */

// ── CONFIG & STATE ──
const CONFIG = {
  dbKey: 'bella_boletos_v2',
  pantryKey: 'bella_pantry_id', 
  defaultPantryId: 'vidal-beauty-sync-v2-automatic', // ID estável para sincronização automática
  months: [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ]
};

let state = {
  boletos: [],
  currentMonth: new Date().getMonth(),
  pendingDeleteId: null,
  searchQuery: ''
};

// ── UTILS ──

/**
 * Formata valor para moeda (BRL)
 * @param {number} value 
 */
const formatCurrency = (value) => 
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

/**
 * Formata valor reduzido (ex: 1.2k)
 * @param {number} value 
 */
const formatShortCurrency = (value) => 
  value >= 1000 ? `R$ ${(value / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1 })}k` : formatCurrency(value);

/**
 * Gera um ID único
 */
const generateUID = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/**
 * Escapa strings para evitar XSS básico
 * @param {string} str 
 */
const escapeHTML = (str) => {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML;
};

// ── PERSISTENCE ──

const loadData = () => {
  try {
    const saved = localStorage.getItem(CONFIG.dbKey);
    state.boletos = saved ? JSON.parse(saved) : [];
  } catch (err) {
    console.error('Erro ao carregar dados:', err);
    state.boletos = [];
  }
};

const saveData = () => {
  localStorage.setItem(CONFIG.dbKey, JSON.stringify(state.boletos));
  
  // Sincronização automática 100% (Sem necessidade do usuário configurar)
  const pId = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
  syncWithCloud(pId, true);

  // Atualiza a lista de sugestões de nomes de clientes
  updateClientsDatalist();
};

/**
 * Coleta todos os nomes de clientes únicos cadastrados e gera as opções do datalist
 */
const updateClientsDatalist = () => {
  const datalist = document.getElementById('clientsList');
  const quickList = document.getElementById('quickClientsList');
  const container = document.getElementById('quickClientsContainer');
  if (!datalist) return;

  const names = new Set();
  state.boletos.forEach(b => {
    if (b.deleted) return; // Ignora excluídos
    (b.itens || []).forEach(it => {
      if (it.cliente && it.cliente.trim()) {
        names.add(it.cliente.trim());
      }
    });
  });

  const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));
  
  // Atualiza o Datalist (Autocomplete invisível)
  datalist.innerHTML = sortedNames
    .map(name => `<option value="${escapeHTML(name)}">`)
    .join('');

  // Atualiza a Lista Rápida no Modal (Botões de inserir)
  if (quickList && container) {
    if (sortedNames.length > 0) {
      container.style.display = 'block';
      quickList.innerHTML = sortedNames.map(name => `
        <button type="button" class="client-chip" data-name="${escapeHTML(name)}">
          ${escapeHTML(name)}
        </button>
      `).join('');

      quickList.querySelectorAll('.client-chip').forEach(btn => {
        btn.onclick = () => addClientToForm(btn.dataset.name);
      });
    } else {
      container.style.display = 'none';
    }
  }

  // Atualiza a Lista de Filtros no Modal de Pop-up
  const mainFilterPopList = document.getElementById('mainFilterPopList');
  const btnTrigger = document.getElementById('btnOpenFilterModal');
  const badge = document.getElementById('activeFilterBadge');

  if (mainFilterPopList) {
    const query = state.searchQuery.toLowerCase().trim();
    const hasActiveFilter = !!query && sortedNames.some(n => n.toLowerCase() === query);
    
    // Atualiza o botão da tela principal
    if (btnTrigger) btnTrigger.classList.toggle('active', hasActiveFilter);
    if (badge) badge.style.display = hasActiveFilter ? 'flex' : 'none';

    mainFilterPopList.innerHTML = sortedNames.map(name => {
      const isActive = query === name.toLowerCase();
      return `
        <button type="button" class="client-chip ${isActive ? 'active' : ''}" data-name="${escapeHTML(name)}">
          ${escapeHTML(name)}
        </button>
      `;
    }).join('');

    mainFilterPopList.querySelectorAll('.client-chip').forEach(btn => {
      btn.onclick = () => {
        toggleMainFilter(btn.dataset.name);
        closeFilterModal();
      };
    });
  }
};

const closeFilterModal = () => {
  document.getElementById('filterModalOverlay').classList.remove('open');
};

/**
 * Filtra a lista principal ao clicar em um chip de cliente
 */
const toggleMainFilter = (name) => {
  const inputSearch = document.getElementById('inputSearch');
  const btnClear = document.getElementById('btnClearSearch');
  
  if (state.searchQuery.toLowerCase() === name.toLowerCase()) {
    state.searchQuery = '';
    inputSearch.value = '';
    btnClear.style.display = 'none';
  } else {
    state.searchQuery = name;
    inputSearch.value = name;
    btnClear.style.display = 'flex';
  }
  
  renderAll();
  updateClientsDatalist(); 
};

/**
 * Adiciona o nome do cliente ao formulário.
 * Se houver uma linha de item vazia, usa ela. Caso contrário, cria uma nova.
 */
const addClientToForm = (name) => {
  const rows = Array.from(document.querySelectorAll('#itensContainer .item-row'));
  const emptyRow = rows.find(row => !row.querySelector('[data-field="cliente"]').value.trim());

  if (emptyRow) {
    const input = emptyRow.querySelector('[data-field="cliente"]');
    input.value = name;
    input.focus();
  } else {
    addItemRow({ cliente: name });
  }
  
  // Também preenche o nome do boleto se estiver vazio
  const flowNome = document.getElementById('fNome');
  if (!flowNome.value.trim()) {
    flowNome.value = `Boleto ${name}`;
  }
};

// ── CLOUD SYNC (PANTRY) ──

/**
 * Sincroniza dados com o Pantry Cloud
 * @param {string} pantryId ID da cesta no getpantry.cloud
 * @param {boolean} push Se true, envia local para nuvem. Se false, puxa da nuvem para local.
 */
const syncWithCloud = async (pantryId, push = true) => {
  if (!pantryId) return;
  const url = `https://getpantry.cloud/apiv1/pantry/${pantryId}/basket/boletos`;

  try {
    // 1. Sempre Puxar primeiro para mesclar (evita sobrescrever dados de outros aparelhos)
    const res = await fetch(url);
    let remoteBoletos = [];
    if (res.ok) {
      const data = await res.json();
      remoteBoletos = (data.boletos && Array.isArray(data.boletos)) ? data.boletos : [];
    }

    // 2. Mesclagem Inteligente (Smart Merge)
    const merged = smartMerge(state.boletos, remoteBoletos);
    const hasChanges = JSON.stringify(merged) !== JSON.stringify(state.boletos);
    
    state.boletos = merged;
    localStorage.setItem(CONFIG.dbKey, JSON.stringify(state.boletos));

    // 3. Se for um PUSH ou se houve mudanças na mesclagem, envia para a nuvem
    if (push || hasChanges) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boletos: state.boletos, lastUpdate: Date.now() })
      });
      console.log('☁️ Sync: Dados sincronizados e mesclados com a nuvem');
    } else {
      console.log('☁️ Sync: Dados locais já estão atualizados');
    }
    
    return true;
  } catch (err) {
    console.error('Erro na sincronização:', err);
    return false;
  }
};

/**
 * Mescla duas listas de boletos baseando-se no ID e na data de atualização
 */
const smartMerge = (local, remote) => {
  const map = new Map();

  // Função auxiliar para comparar e manter o mais novo
  const mergeItem = (item) => {
    const existing = map.get(item.id);
    if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
      map.set(item.id, item);
    }
  };

  remote.forEach(mergeItem);
  local.forEach(mergeItem);

  return Array.from(map.values());
};

const copySyncId = () => {
  const idInput = document.getElementById('pantryId');
  if (!idInput || !idInput.value) {
    showToast('⚠️ Insira um ID primeiro.');
    return;
  }
  navigator.clipboard.writeText(idInput.value).then(() => {
    showToast('📋 ID copiado! Envie para o outro dispositivo.');
  });
};

// ── UI COMPONENTS ──

/**
 * Renderiza o seletor de meses
 */
const renderMonthSelector = () => {
  const container = document.getElementById('monthScroll');
  if (!container) return;

  const fragment = document.createDocumentFragment();
  CONFIG.months.forEach((month, index) => {
    const btn = document.createElement('button');
    btn.className = `month-btn ${index === state.currentMonth ? 'active' : ''}`;
    btn.textContent = month;
    btn.setAttribute('aria-pressed', index === state.currentMonth);
    btn.onclick = () => {
      state.currentMonth = index;
      renderMonthSelector();
      renderAll();
    };
    fragment.appendChild(btn);
  });

  container.innerHTML = '';
  container.appendChild(fragment);

  // Auto-scroll para o mês ativo
  setTimeout(() => {
    const active = container.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, 100);
};

/**
 * Cria o elemento HTML de um item (cliente/produto) dentro do boleto
 */
const createDetailItemHTML = (item) => `
  <div class="detail-item">
    <div class="detail-left">
      <div class="detail-client">
        <i class="fa-solid fa-user" aria-hidden="true" style="font-size:10px;opacity:.5;margin-right:4px"></i>
        ${escapeHTML(item.cliente)}
      </div>
      <div class="detail-product">${escapeHTML(item.produto)}</div>
    </div>
    <div class="detail-value-group">
      <div class="detail-cost" title="Custo para você">C: ${formatCurrency(item.valor)}</div>
      <div class="detail-sale" title="Venda para cliente">V: ${formatCurrency(item.valor_venda || 0)}</div>
    </div>
  </div>
`;

/**
 * Constrói o elemento de um Card de Boleto
 */
const buildBoletoCard = (boleto, index) => {
  const card = document.createElement('article');
  
  const totalBoletoSale = (boleto.itens || []).reduce((sum, it) => sum + (Number(it.valor_venda) || 0), 0) || Number(boleto.valor_venda) || 0;

  card.className = `boleto-card ${boleto.pago ? 'paid' : ''}`;
  card.style.animationDelay = `${Math.min(index * 0.05, 0.4)}s`;
  card.dataset.id = boleto.id;

  const contaClass = (() => {
    const c = (boleto.conta || '').toLowerCase();
    if (c === 'deise') return 'conta-deise';
    if (c === 'aragonez') return 'conta-aragonez';
    return 'conta-other';
  })();

  const itemsHTML = (boleto.itens || []).map(createDetailItemHTML).join('');

  card.innerHTML = `
    <header class="boleto-header">
      <div class="boleto-header-left">
        <div class="boleto-date-row">
          <span class="boleto-date"><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${escapeHTML(String(boleto.dia).padStart(2, '0'))}/${escapeHTML(String(boleto.mes + 1).padStart(2, '0'))}</span>
          <span class="conta-badge ${contaClass}"><i class="fa-solid fa-building-columns" aria-hidden="true"></i> ${escapeHTML(boleto.conta)}</span>
        </div>
        <h3 class="boleto-name">${escapeHTML(boleto.nome)}</h3>
      </div>
      <span class="parcela-badge">Parcela ${escapeHTML(boleto.parcelaAtual)}/${escapeHTML(boleto.parcelaTotal)}</span>
    </header>
    
    <div class="boleto-body">
      <div class="boleto-value-stack">
        <span class="boleto-value-cost" title="Total que você paga">Boleto: ${formatCurrency(boleto.valor)}</span>
        <span class="boleto-value">${formatCurrency(totalBoletoSale)}</span>
      </div>
      <div class="boleto-actions">
        <button class="btn-pay ${boleto.pago ? 'paid-btn' : ''}" data-action="toggle-pay" aria-label="${boleto.pago ? 'Marcar como pendente' : 'Marcar como pago'}">
          <span class="checkmark">${boleto.pago ? '<i class="fa-solid fa-check"></i>' : ''}</span>
          ${boleto.pago ? 'Pago' : 'Pagar'}
        </button>
        <button class="btn-details" data-action="toggle-details">
          <i class="fa-solid fa-chevron-down btn-chevron" id="chev-${boleto.id}"></i> Detalhes
        </button>
      </div>
    </div>

    <div class="boleto-details" id="det-${boleto.id}">
      <div class="details-content">
        <div class="details-inner">
          <span class="details-header-title"><i class="fa-solid fa-receipt"></i> Itens do Boleto</span>
          ${itemsHTML || '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:8px">Nenhum item cadastrado.</p>'}
        </div>
      </div>
    </div>

    <footer class="card-footer-actions">
      <button class="btn-edit" data-action="edit"><i class="fa-solid fa-pen"></i> Editar</button>
      <button class="btn-delete" data-action="delete"><i class="fa-solid fa-trash"></i> Excluir</button>
    </footer>
  `;

  return card;
};

// ── CORE LOGIC ──

const renderAll = () => {
  const query = state.searchQuery.toLowerCase().trim();
  
  const filtered = state.boletos
    .filter(b => {
      // Ignora boletos excluídos logicamente
      if (b.deleted) return false;

      // Se houver busca, ignora o filtro de mês para mostrar resultados globais
      const matchesMonth = query || b.mes === state.currentMonth;
      if (!matchesMonth) return false;

      if (!query) return true;

      // Busca no nome do boleto
      const matchesBoletoName = b.nome.toLowerCase().includes(query);
      
      // Busca nos nomes dos clientes dentro dos itens
      const matchesClientName = (b.itens || []).some(it => 
        (it.cliente || '').toLowerCase().includes(query)
      );

      return matchesBoletoName || matchesClientName;
    })
    .sort((a, b) => (a.dia || 0) - (b.dia || 0));

  // Totais
  const totalCost = filtered.reduce((acc, b) => acc + Number(b.valor), 0);
  const totalSales = filtered.reduce((acc, b) => {
    const saleItemsSum = (b.itens || []).reduce((sum, it) => sum + (Number(it.valor_venda) || 0), 0);
    return acc + (saleItemsSum || Number(b.valor_venda) || 0); // Fallback para b.valor_venda se não houver itens
  }, 0);
  
  const receivedValue = filtered.filter(b => b.pago).reduce((acc, b) => {
     const saleItemsSum = (b.itens || []).reduce((sum, it) => sum + (Number(it.valor_venda) || 0), 0);
     return acc + (saleItemsSum || Number(b.valor_venda) || 0);
  }, 0);

  document.getElementById('summaryTotal').textContent = formatShortCurrency(totalCost);
  document.getElementById('summarySales').textContent = formatShortCurrency(totalSales);
  document.getElementById('summaryReceived').textContent = formatShortCurrency(receivedValue);
  document.getElementById('summaryPending').textContent = formatShortCurrency(totalSales - receivedValue);
  document.getElementById('boletoCount').textContent = filtered.length;

  const listContainer = document.getElementById('boletoList');
  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    const isSearching = !!query;
    listContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${isSearching ? '🔍' : '🌸'}</div>
        <p class="empty-title">${isSearching ? 'Nenhum resultado' : 'Nenhum boleto'}</p>
        <p class="empty-sub">${isSearching ? 'Tente buscar por outro nome.' : `Toque em + para adicionar o primeiro boleto de ${CONFIG.months[state.currentMonth]}.`}</p>
      </div>
    `;
    return;
  }

  const pendingList = filtered.filter(b => !b.pago);
  const paidList = filtered.filter(b => b.pago);

  const fragment = document.createDocumentFragment();

  pendingList.forEach((b, i) => fragment.appendChild(buildBoletoCard(b, i)));

  if (paidList.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'paid-divider';
    divider.innerHTML = `<span><i class="fa-solid fa-circle-check"></i> Pagos (${paidList.length})</span>`;
    fragment.appendChild(divider);
    paidList.forEach((b, i) => fragment.appendChild(buildBoletoCard(b, pendingList.length + i)));
  }

  listContainer.appendChild(fragment);
};

const handleBoletoAction = (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const card = btn.closest('.boleto-card');
  const id = card.dataset.id;
  const action = btn.dataset.action;

  if (action === 'toggle-pay') togglePaymentStatus(id);
  if (action === 'toggle-details') toggleCardDetails(id);
  if (action === 'edit') openEditModal(id);
  if (action === 'delete') initiateDelete(id);
};

const togglePaymentStatus = (id) => {
  const b = state.boletos.find(x => x.id === id);
  if (!b) return;
  b.pago = !b.pago;
  b.updatedAt = Date.now(); // Marca atualização
  saveData();
  renderAll();
  showToast(b.pago ? '✅ Pago com sucesso!' : '↩️ Status alterado para pendente');
};

const toggleCardDetails = (id) => {
  const detailPanel = document.getElementById(`det-${id}`);
  const chevron = document.getElementById(`chev-${id}`);
  if (!detailPanel) return;

  const isOpen = detailPanel.classList.toggle('open');
  if (chevron) chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
};

// ── MODAL & FORM ──

const openModal = (editing = false) => {
  document.getElementById('modalOverlay').classList.add('open');
  document.getElementById('modalTitle').textContent = editing ? 'Editar Boleto' : 'Novo Boleto';
};

const closeModal = () => {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
  document.getElementById('filterModalOverlay').classList.remove('open');
  clearForm();
};

const openFilterModal = () => {
  document.getElementById('filterModalOverlay').classList.add('open');
};

const openSettings = () => {
  const pId = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
  document.getElementById('pantryId').value = pId;
  document.getElementById('settingsOverlay').classList.add('open');
};

const clearForm = () => {
  document.getElementById('boletoForm').reset();
  document.getElementById('editId').value = '';
  document.getElementById('editGroupId').value = '';
  document.getElementById('itensContainer').innerHTML = '';
  document.getElementById('autoInfo').style.display = 'none';
};

const populateMonthSelect = () => {
  const select = document.getElementById('fMes');
  select.innerHTML = '';
  CONFIG.months.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = m;
    select.appendChild(opt);
  });
  select.value = state.currentMonth;
};

const addItemRow = (data = null) => {
  const container = document.getElementById('itensContainer');
  const div = document.createElement('div');
  div.className = 'item-row';
  div.innerHTML = `
    <button type="button" class="btn-remove-item" aria-label="Remover item"><i class="fa-solid fa-xmark"></i></button>
    <div class="item-row-grid">
      <input class="form-input-sm" placeholder="Cliente" data-field="cliente" list="clientsList" value="${escapeHTML(data?.cliente || '')}">
      <input class="form-input-sm" placeholder="Produto" data-field="produto" value="${escapeHTML(data?.produto || '')}">
    </div>
    <div class="item-row-grid">
      <input class="form-input-sm" type="number" placeholder="Custo R$ (P/ Boticário)" data-field="valor" step="0.01" min="0" value="${data?.valor || ''}">
      <input class="form-input-sm" type="number" placeholder="Venda R$ (Da Cliente)" data-field="valor_venda" step="0.01" min="0" value="${data?.valor_venda || ''}">
    </div>
  `;
  div.querySelector('.btn-remove-item').onclick = () => div.remove();
  container.appendChild(div);
};

const collectFormData = () => {
  const itemRows = Array.from(document.querySelectorAll('#itensContainer .item-row'));
  const itens = itemRows.map(row => ({
    cliente: row.querySelector('[data-field="cliente"]').value.trim(),
    produto: row.querySelector('[data-field="produto"]').value.trim(),
    valor: parseFloat(row.querySelector('[data-field="valor"]').value) || 0,
    valor_venda: parseFloat(row.querySelector('[data-field="valor_venda"]').value) || 0
  })).filter(it => it.cliente || it.produto);

  return {
    dia: parseInt(document.getElementById('fDia').value),
    valor: parseFloat(document.getElementById('fValor').value),
    nome: document.getElementById('fNome').value.trim(),
    parcelaAtual: parseInt(document.getElementById('fParcelaAtual').value),
    parcelaTotal: parseInt(document.getElementById('fParcelaTotal').value),
    conta: document.getElementById('fConta').value,
    mes: parseInt(document.getElementById('fMes').value),
    editId: document.getElementById('editId').value,
    editGroupId: document.getElementById('editGroupId').value,
    itens
  };
};

const saveBoleto = (e) => {
  e.preventDefault();
  const data = collectFormData();

  if (!data.dia || isNaN(data.valor) || !data.nome || !data.parcelaAtual || !data.parcelaTotal) {
    showToast('⚠️ Preencha todos os campos obrigatórios!');
    return;
  }

  if (data.editId) {
    const idx = state.boletos.findIndex(b => b.id === data.editId);
    if (idx > -1) {
      state.boletos[idx] = {
        ...state.boletos[idx],
        ...data,
        parcelaAtual: String(data.parcelaAtual),
        parcelaTotal: String(data.parcelaTotal),
        updatedAt: Date.now() // Marca atualização
      };
      delete state.boletos[idx].editId;
      delete state.boletos[idx].editGroupId;
    }
    showToast('✏️ Boleto atualizado!');
  } else {
    // Geração automática de parcelas
    const groupId = generateUID();
    const now = Date.now();
    for (let p = data.parcelaAtual; p <= data.parcelaTotal; p++) {
      const targetMes = (data.mes + (p - data.parcelaAtual)) % 12;
      const itemsForP = data.itens.map(it => ({
        ...it,
        parcela_item: `${p}/${data.parcelaTotal}`,
        produto: it.produto.replace(/^\d+\/\d+\s*/, `${p}/${data.parcelaTotal} `)
      }));

      state.boletos.push({
        id: generateUID(),
        groupId,
        dia: data.dia,
        mes: targetMes,
        valor: data.valor,
        nome: data.nome,
        parcelaAtual: String(p),
        parcelaTotal: String(data.parcelaTotal),
        conta: data.conta,
        pago: false,
        itens: itemsForP,
        updatedAt: now // Marca criação
      });
    }
    showToast(data.parcelaTotal > data.parcelaAtual ? '🌸 Parcelas geradas com sucesso!' : '🌸 Boleto adicionado!');
  }

  saveData();
  closeModal();
  state.currentMonth = data.mes;
  renderMonthSelector();
  renderAll();
};

const openEditModal = (id) => {
  const b = state.boletos.find(x => x.id === id);
  if (!b) return;

  populateMonthSelect();
  document.getElementById('editId').value = b.id;
  document.getElementById('editGroupId').value = b.groupId || '';
  document.getElementById('fDia').value = b.dia;
  document.getElementById('fValor').value = b.valor;
  document.getElementById('fNome').value = b.nome;
  document.getElementById('fParcelaAtual').value = b.parcelaAtual;
  document.getElementById('fParcelaTotal').value = b.parcelaTotal;
  document.getElementById('fConta').value = b.conta;
  document.getElementById('fMes').value = b.mes;

  document.getElementById('itensContainer').innerHTML = '';
  (b.itens || []).forEach(it => addItemRow(it));
  
  openModal(true);
};

// ── DELETE CONFIRMATION ──

const initiateDelete = (id) => {
  const b = state.boletos.find(x => x.id === id);
  if (!b) return;

  state.pendingDeleteId = id;
  const groupCount = b.groupId ? state.boletos.filter(x => x.groupId === b.groupId).length : 0;
  
  const container = document.getElementById('confirmActions');
  container.innerHTML = `
    <button class="btn-confirm-cancel" id="confirmCancel">Cancelar</button>
    <button class="btn-confirm-ok" id="confirmOk">Só este</button>
  `;

  const msg = document.getElementById('confirmMsg');
  if (groupCount > 1) {
    msg.innerHTML = `Este boleto faz parte de um grupo de <strong>${groupCount} parcelas</strong>.<br>O que deseja excluir?`;
    const btnAll = document.createElement('button');
    btnAll.className = 'btn-confirm-all';
    btnAll.textContent = `Todas as ${groupCount}`;
    btnAll.onclick = () => confirmActionDelete(true);
    container.appendChild(btnAll);
  } else {
    msg.innerHTML = `Excluir o boleto <strong>"${escapeHTML(b.nome)}"</strong>?`;
    document.getElementById('confirmOk').textContent = 'Excluir';
  }

  document.getElementById('confirmOk').onclick = () => confirmActionDelete(false);
  document.getElementById('confirmCancel').onclick = () => document.getElementById('confirmOverlay').classList.remove('open');
  document.getElementById('confirmOverlay').classList.add('open');
};

const confirmActionDelete = (deleteAllGroup) => {
  const b = state.boletos.find(x => x.id === state.pendingDeleteId);
  if (!b) return;

  const now = Date.now();
  if (deleteAllGroup && b.groupId) {
    let count = 0;
    state.boletos.forEach(x => {
      if (x.groupId === b.groupId && !x.deleted) {
        x.deleted = true;
        x.updatedAt = now;
        count++;
      }
    });
    showToast(`🗑️ ${count} parcelas removidas`);
  } else {
    b.deleted = true;
    b.updatedAt = now;
    showToast('🗑️ Boleto removido');
  }

  saveData();
  renderAll();
  document.getElementById('confirmOverlay').classList.remove('open');
};

// ── TOAST ──
let toastTimeout;
const showToast = (msg) => {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
};

// ── BACKUP HANDLERS ──

const exportData = () => {
  const dataStr = JSON.stringify(state.boletos, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vidal-beauty-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Backup exportado com sucesso!');
};

const importData = (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (Array.isArray(imported)) {
        state.boletos = imported;
        saveData();
        renderAll();
        showToast('📤 Dados importados com sucesso!');
        closeModal();
      } else {
        throw new Error('Formato inválido');
      }
    } catch (err) {
      showToast('❌ Erro ao importar arquivo!');
    }
  };
  reader.readAsText(file);
};

const resetAllData = () => {
  if (confirm('⚠️ TEM CERTEZA? Isso apagará TODOS os seus boletos permanentemente.')) {
    state.boletos = [];
    saveData();
    seedData();
    renderAll();
    showToast('🗑️ Todos os dados foram resetados.');
    closeModal();
  }
};

const savePantryConfig = () => {
  const id = document.getElementById('pantryId').value.trim();
  if (id) {
    localStorage.setItem(CONFIG.pantryKey, id);
    syncWithCloud(id, false).then(() => {
      showToast('☁️ Cloud configurada e sincronizada!');
      closeModal();
    });
  } else {
    localStorage.removeItem(CONFIG.pantryKey);
    showToast('☁️ Sincronização em nuvem desativada.');
  }
};

const seedData = (force = false) => {
  if (state.boletos.length > 0 && !force) return;

  const mk = (dia, mes, valor, nome, pA, pT, conta, pago, itens, gId = null) => ({
    id: generateUID(),
    groupId: gId || generateUID(),
    dia, mes, valor, nome,
    parcelaAtual: String(pA), parcelaTotal: String(pT),
    conta, pago: !!pago, itens,
    updatedAt: 1640995200000 // Data fixa antiga para o seed não sobrescrever dados reais
  });

  const G = {
    irmaoGisele: generateUID(), valeria: generateUID(), alex: generateUID(),
    giovBeatrizFa: generateUID(), giovFaGiseleAline: generateUID(),
    faArag: generateUID(), giseleDeise: generateUID(), giovGabriela: generateUID(),
    faDeise2: generateUID(), gabrielaRose: generateUID(), faDeise3: generateUID(),
    aline: generateUID(), gabrielaNina: generateUID()
  };

  state.boletos = [
    /* ── ABRIL (mes=3) ────────────────────────────────────── */
    mk(1, 3, 34.82, 'Boleto Irmão Gisele', 1, 3, 'Deise', false, [
      { cliente: 'Irmão Gisele', produto: 'Lilly', parcela_item: '1/3', valor: 34.82, valor_venda: 48.63 }
    ], G.irmaoGisele),

    mk(2, 3, 96.25, 'Boleto Valéria', 1, 3, 'Aragonez', true, [
      { cliente: 'Valéria', produto: 'Kit Malbec Anticaspa', parcela_item: '1/3', valor: 28.30, valor_venda: 43.40 },
      { cliente: 'Valéria', produto: 'Creme Nativa Spa', parcela_item: '1/3', valor: 19.80, valor_venda: 20.00 },
      { cliente: 'Valéria', produto: 'Coffee', parcela_item: '1/3', valor: 48.13, valor_venda: 59.96 }
    ], G.valeria),

    mk(6, 3, 116.11, 'Boleto Alex', 1, 3, 'Aragonez', true, [
      { cliente: 'Alex', produto: 'Malbec Bleu', parcela_item: '1/3', valor: 56.64, valor_venda: 66.63 },
      { cliente: 'Alex', produto: 'Malbec Tradicional', parcela_item: '1/3', valor: 59.47, valor_venda: 76.63 }
    ], G.alex),

    mk(6, 3, 69.85, 'Boleto Giovana, Beatriz e Fa', 1, 3, 'Aragonez', false, [
      { cliente: 'Fa', produto: 'Óleo Fa', parcela_item: '1/3', valor: 23.48, valor_venda: 28.63 },
      { cliente: 'Giovana', produto: 'Base Nina', parcela_item: '1/3', valor: 19.24, valor_venda: 19.24 },
      { cliente: 'Beatriz', produto: 'Rímel Turbo', parcela_item: '1/3', valor: 8.72, valor_venda: 21.63 },
      { cliente: 'Beatriz', produto: 'Protetor Solar', parcela_item: '1/3', valor: 18.38, valor_venda: 23.96 }
    ], G.giovBeatrizFa),

    mk(8, 3, 119.90, 'Boleto Giovana, Fa, Gisele e Aline', 2, 3, 'Deise', false, [
      { cliente: 'Flávia', produto: 'Sabonete em Barra', parcela_item: '2/3', valor: 11.30, valor_venda: 11.30 },
      { cliente: 'Gisele', produto: 'Lápis de Olho', parcela_item: '2/3', valor: 19.24, valor_venda: 23.34 },
      { cliente: 'Aline', produto: 'Lápis de Olho', parcela_item: '2/3', valor: 19.24, valor_venda: 23.34 },
      { cliente: 'Flávia', produto: 'Creme Lilly', parcela_item: '2/3', valor: 41.05, valor_venda: 41.05 },
      { cliente: 'Stefany', produto: 'Creme Presente', parcela_item: '2/3', valor: 15.73, valor_venda: 15.73 },
      { cliente: 'Stefany', produto: 'Sabonete Presente', parcela_item: '2/3', valor: 13.33, valor_venda: 13.33 }
    ], G.giovFaGiseleAline),

    mk(9, 3, 44.22, 'Boleto Fa', 1, 3, 'Aragonez', false, [
      { cliente: 'Fa', produto: 'Condicionador Siage', parcela_item: '1/3', valor: 12.49, valor_venda: 19.96 },
      { cliente: 'Fa', produto: 'Shampoo Siage', parcela_item: '1/3', valor: 11.99, valor_venda: 19.96 },
      { cliente: 'Fa', produto: 'Máscara Siage', parcela_item: '1/3', valor: 14.72, valor_venda: 19.96 }
    ], G.faArag),

    mk(10, 3, 249.20, 'Boleto Gisele, Aline e Beatriz', 3, 3, 'Aragonez', false, [
      { cliente: 'Gisele', produto: 'Lilly', parcela_item: '3/3', valor: 34.82, valor_venda: 61.45 },
      { cliente: 'Gisele', produto: 'Hercode', parcela_item: '3/3', valor: 84.97, valor_venda: 99.97 },
      { cliente: 'Aline', produto: 'Hercode', parcela_item: '3/3', valor: 84.97, valor_venda: 99.97 },
      { cliente: 'Aline', produto: 'Batom', parcela_item: '3/3', valor: 14.98, valor_venda: 17.64 },
      { cliente: 'Beatriz', produto: 'Perfume Beatriz', parcela_item: '3/3', valor: 29.44, valor_venda: 37.30 }
    ], G.giovFaGiseleAline),

    mk(13, 3, 26.14, 'Boleto Gisele', 2, 3, 'Deise', false, [
      { cliente: 'Gisele', produto: 'Shampoo Coco', parcela_item: '2/3', valor: 4.77, valor_venda: 10.22 },
      { cliente: 'Gisele', produto: 'Condicionador Coco', parcela_item: '2/3', valor: 8.47, valor_venda: 10.22 },
      { cliente: 'Gisele', produto: 'Máscara Coco', parcela_item: '2/3', valor: 7.90, valor_venda: 10.22 }
    ], G.giseleDeise),

    mk(15, 3, 105.84, 'Boleto Giovana e Gabriela', 2, 3, 'Deise', false, [
      { cliente: 'Giovana', produto: 'Combo Siage', parcela_item: '2/3', valor: 11.99, valor_venda: 11.99 },
      { cliente: 'Giovana', produto: 'Kit Giovana', parcela_item: '2/3', valor: 12.79, valor_venda: 12.79 },
      { cliente: 'Giovana', produto: 'Máscara', parcela_item: '2/3', valor: 18.13, valor_venda: 18.13 },
      { cliente: 'Giovana', produto: 'Leave-in', parcela_item: '2/3', valor: 9.99, valor_venda: 9.99 },
      { cliente: 'Gabriela', produto: 'Kit Cabelo', parcela_item: '2/3', valor: 52.92, valor_venda: 63.34 }
    ], G.giovGabriela),

    mk(15, 3, 28.86, 'Boleto Fa', 1, 2, 'Deise', false, [
      { cliente: 'Fa', produto: 'Lápis de Olho', parcela_item: '1/2', valor: 28.86, valor_venda: 35.00 }
    ], G.faDeise2),

    mk(15, 3, 93.30, 'Boleto Gabriela', 2, 3, 'Deise', false, [
      { cliente: 'Gabriela', produto: 'Creme Rosê', parcela_item: '2/3', valor: 29.33, valor_venda: 36.66 },
      { cliente: 'Gabriela', produto: 'Perfume Rosê', parcela_item: '2/3', valor: 63.97, valor_venda: 80.00 }
    ], G.gabrielaRose),

    mk(17, 3, 21.51, 'Boleto Fa', 2, 3, 'Deise', false, [
      { cliente: 'Fa', produto: 'Base', parcela_item: '2/3', valor: 21.51, valor_venda: 31.67 }
    ], G.faDeise3),

    mk(22, 3, 52.39, 'Boleto Aline', 2, 3, 'Deise', false, [
      { cliente: 'Aline', produto: 'Kit Clash', parcela_item: '2/3', valor: 52.39, valor_venda: 71.66 }
    ], G.aline),

    mk(27, 3, 20.53, 'Boleto Gabriela', 2, 3, 'Deise', false, [
      { cliente: 'Gabriela', produto: 'Base Nina', parcela_item: '2/3', valor: 20.53, valor_venda: 31.67 }
    ], G.gabrielaNina),

    /* ── MAIO (mes=4) ─────────────────────────────────────── */
    mk(4, 4, 96.25, 'Boleto Valéria', 2, 3, 'Aragonez', false, [
      { cliente: 'Valéria', produto: 'Kit Malbec Anticaspa', parcela_item: '2/3', valor: 28.30, valor_venda: 43.40 },
      { cliente: 'Valéria', produto: 'Creme Nativa Spa', parcela_item: '2/3', valor: 19.80, valor_venda: 20.00 },
      { cliente: 'Valéria', produto: 'Coffee', parcela_item: '2/3', valor: 48.13, valor_venda: 59.96 }
    ], G.valeria),

    mk(4, 4, 34.82, 'Boleto Irmão Gisele', 2, 3, 'Deise', false, [
      { cliente: 'Irmão Gisele', produto: 'Lilly', parcela_item: '2/3', valor: 34.82, valor_venda: 48.63 }
    ], G.irmaoGisele),

    mk(6, 4, 116.11, 'Boleto Alex', 2, 3, 'Aragonez', false, [
      { cliente: 'Alex', produto: 'Malbec Bleu', parcela_item: '2/3', valor: 56.64, valor_venda: 66.63 },
      { cliente: 'Alex', produto: 'Malbec Tradicional', parcela_item: '2/3', valor: 59.47, valor_venda: 76.63 }
    ], G.alex),

    /* ── JUNHO (mes=5) ────────────────────────────────────── */
    mk(3, 5, 96.25, 'Boleto Valéria', 3, 3, 'Aragonez', false, [
      { cliente: 'Valéria', produto: 'Kit Malbec Anticaspa', parcela_item: '3/3', valor: 28.30, valor_venda: 43.40 },
      { cliente: 'Valéria', produto: 'Creme Nativa Spa', parcela_item: '3/3', valor: 19.80, valor_venda: 20.00 },
      { cliente: 'Valéria', produto: 'Coffee', parcela_item: '3/3', valor: 48.13, valor_venda: 59.96 }
    ], G.valeria),

    mk(5, 5, 116.12, 'Boleto Alex', 3, 3, 'Aragonez', false, [
      { cliente: 'Alex', produto: 'Malbec Bleu', parcela_item: '3/3', valor: 56.64, valor_venda: 66.63 },
      { cliente: 'Alex', produto: 'Malbec Tradicional', parcela_item: '3/3', valor: 59.47, valor_venda: 76.63 }
    ], G.alex),

    mk(3, 5, 34.82, 'Boleto Irmão Gisele', 3, 3, 'Deise', false, [
      { cliente: 'Irmão Gisele', produto: 'Lilly', parcela_item: '3/3', valor: 34.82, valor_venda: 48.63 }
    ], G.irmaoGisele),
  ];
  saveData();
};

// ── INITIALIZATION ──

const init = async () => {
  // 1. Carrega localmente primeiro
  loadData();
  
  // 2. Sincronização Automática Total
  // Usa o ID configurado ou o ID estável padrão
  const pId = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
  
  const pulled = await syncWithCloud(pId, false);
  if (pulled) {
    console.log('✨ Inicialização: Dados sincronizados automaticamente.');
  }

  // 3. Verifica se precisa de Seed (apenas se estiver VAZIO total)
  const isEssentiallyEmpty = state.boletos.length === 0 || 
                             (!state.boletos.some(b => (b.itens || []).length > 0) && state.boletos.length < 5);

  if (!localStorage.getItem(CONFIG.dbKey) && isEssentiallyEmpty) { 
    state.boletos = []; 
    seedData(true); 
  }
  
  // Inicia no mês ATUAL
  state.currentMonth = new Date().getMonth(); 

  renderMonthSelector();
  renderAll();
  updateClientsDatalist();

  // 4. Sincronização Periódica e por Visibilidade
  setInterval(async () => {
    const activePId = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
    if (await syncWithCloud(activePId, false)) renderAll();
  }, 60000); // A cada 1 minuto

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      const activePId = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
      if (await syncWithCloud(activePId, false)) renderAll();
    }
  });

  // Event Listeners
  document.getElementById('boletoList').addEventListener('click', handleBoletoAction);
  document.getElementById('fabAdd').onclick = () => {
    populateMonthSelect();
    openModal();
  };
  document.getElementById('btnCloseModal').onclick = closeModal;
  document.getElementById('btnAddItem').onclick = () => addItemRow();
  document.getElementById('btnSalvar').onclick = saveBoleto;

  // Novos Listeners de Config/Sync
  document.getElementById('btnSettings').onclick = openSettings;
  // Listener de Sincronização Manual (agora no menu configurações também)
  // Define o listener para ambos os botões de sync (um na header e um nas configs)
  document.querySelectorAll('#btnSync, #btnSyncManual').forEach(btn => {
    btn.onclick = async () => {
      const pIdSync = localStorage.getItem(CONFIG.pantryKey) || CONFIG.defaultPantryId;
      showToast('☁️ Sincronizando...');
      await syncWithCloud(pIdSync, false); // Puxa o mais recente
      renderAll();
      showToast('🔄 Sincronizado com a nuvem!');
    };
  });
  document.getElementById('btnCloseSettings').onclick = closeModal;
  document.getElementById('btnExport').onclick = exportData;
  document.getElementById('btnImport').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = importData;
  document.getElementById('btnResetAll').onclick = resetAllData;
  // document.getElementById('btnSavePantry').onclick = savePantryConfig; // Botão removido na versão automática
  document.getElementById('btnCopySyncId').onclick = copySyncId;

  // Listeners do Filtro (Pop-up)
  document.getElementById('btnOpenFilterModal').onclick = openFilterModal;
  document.getElementById('btnCloseFilterModal').onclick = closeModal;
  document.getElementById('btnClearAllFilters').onclick = () => {
    state.searchQuery = '';
    document.getElementById('inputSearch').value = '';
    document.getElementById('btnClearSearch').style.display = 'none';
    renderAll();
    updateClientsDatalist();
    closeModal();
  };

  // Fechar modal ao clicar fora
  document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  };
  document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target.id === 'settingsOverlay') closeModal();
  };
  document.getElementById('filterModalOverlay').onclick = (e) => {
    if (e.target.id === 'filterModalOverlay') closeModal();
  };

  // Busca
  const inputSearch = document.getElementById('inputSearch');
  const btnClear = document.getElementById('btnClearSearch');

  inputSearch.oninput = (e) => {
    state.searchQuery = e.target.value;
    btnClear.style.display = state.searchQuery ? 'flex' : 'none';
    renderAll();
    updateClientsDatalist(); 
  };

  btnClear.onclick = () => {
    inputSearch.value = '';
    state.searchQuery = '';
    btnClear.style.display = 'none';
    renderAll();
    updateClientsDatalist(); 
  };

  // Auto-info updates
  ['fParcelaAtual', 'fParcelaTotal', 'fDia', 'fMes'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateAutoGenerationPreview);
  });
};

const updateAutoGenerationPreview = () => {
  const atual = parseInt(document.getElementById('fParcelaAtual').value) || 0;
  const total = parseInt(document.getElementById('fParcelaTotal').value) || 0;
  const dia = parseInt(document.getElementById('fDia').value) || 0;
  const mes = parseInt(document.getElementById('fMes').value);
  const editId = document.getElementById('editId').value;
  
  const box = document.getElementById('autoInfo');
  const txt = document.getElementById('autoInfoText');

  if (editId || atual <= 0 || total <= 0 || dia <= 0 || atual >= total) {
    box.style.display = 'none';
    return;
  }

  const remaining = total - atual;
  const previews = [];
  for (let i = 1; i <= remaining; i++) {
    const m = (mes + i) % 12;
    previews.push(`${String(dia).padStart(2, '0')}/${String(m + 1).padStart(2, '0')} (${atual + i}/${total})`);
  }

  txt.innerHTML = `<strong>✨ Auto-geração:</strong> Criará +${remaining} parcelas: ${previews.join(' · ')}`;
  box.style.display = 'flex';
};

window.addEventListener('DOMContentLoaded', init);

