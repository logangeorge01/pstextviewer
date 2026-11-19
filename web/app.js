/* global document, window, localStorage, Blob, URL */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const kinds = {
    throw: { label: 'Throws', color: 'var(--red)' },
    error: { label: 'Errors', color: 'var(--red)' },
    exception: { label: 'Exceptions', color: 'var(--red)' },
    warning: { label: 'Warnings', color: 'var(--amber)' },
    verbose: { label: 'Verbose', color: 'var(--muted)' },
    debug: { label: 'Debug', color: 'var(--muted)' },
    information: { label: 'Information', color: 'var(--blue)' },
    trace: { label: 'Traces', color: 'var(--purple)' },
    output: { label: 'Output', color: 'var(--blue)' },
    prompt: { label: 'Prompts', color: 'var(--purple)' },
    synopsis: { label: 'Synopsis', color: 'var(--blue)' },
    description: { label: 'Description', color: 'var(--blue)' },
    parameter: { label: 'Parameters', color: 'var(--blue)' },
    example: { label: 'Examples', color: 'var(--blue)' },
    notes: { label: 'Notes', color: 'var(--blue)' }
  };
  const Model = window.PSTextModel;
  const state = {
    current: 'atlas', selected: null, query: '', history: [], showHelpers: false,
    kind: null, review: 'all', quality: 'all', duplicate: null, searchAll: false, zoom: 1, limit: 400
  };
  let data, model, functions, messages, roots, searchText, reviews, datasetKey, matching, summaries, visited;
  const miniRects = new Map(), miniEdges = new Map();
  let toastTimer, storageAvailable = true;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'onclick') node.addEventListener('click', value);
      else if (key === 'style') {
        for (const [property, setting] of Object.entries(value)) node.style.setProperty(property, setting);
      } else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  function button(text, className, action, attrs = {}) {
    return el('button', { type: 'button', class: className, onclick: action, ...attrs }, text);
  }
  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 5000);
  }
  function format(n) { return Number(n).toLocaleString(); }
  function reviewOf(id) { return reviews[id] || { status: 'unreviewed', comment: '' }; }
  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16);
  }
  function validateMap(map) {
    if (!map || map.schemaVersion !== 1 || typeof map.name !== 'string' || typeof map.sourcePath !== 'string' ||
        !Array.isArray(map.functions) || !Array.isArray(map.messages) || !Array.isArray(map.diagnostics) ||
        !Array.isArray(map.limitations) || !map.stats) throw new Error('Not a PSTextViewer v1 map.');
    const functionIds = new Set(), messageIds = new Set();
    for (const f of map.functions) {
      if (!f || typeof f.id !== 'string' || functionIds.has(f.id) ||
          !['name', 'file', 'scopeType', 'exportReason', 'parentId'].every(k => typeof f[k] === 'string') ||
          !['calls', 'messageIds', 'rootIds'].every(k => Array.isArray(f[k]) && f[k].every(v => typeof v === 'string')) ||
          typeof f.exported !== 'boolean' || !Number.isInteger(f.line)) throw new Error('Invalid function in map.');
      functionIds.add(f.id);
    }
    if (map.callSites !== undefined && (!Array.isArray(map.callSites) || !map.callSites.every(c =>
      c && functionIds.has(c.functionId) && functionIds.has(c.targetId) && Number.isInteger(c.line) &&
      typeof c.expression === 'string' && Array.isArray(c.branches) &&
      c.branches.every(b => b && typeof b.label === 'string' && Number.isInteger(b.line))))) {
      throw new Error('Invalid call sites in map.');
    }
    for (const m of map.messages) {
      if (!m || typeof m.id !== 'string' || messageIds.has(m.id) || !functionIds.has(m.functionId) ||
          !['kind', 'text', 'file', 'expression', 'source', 'resolution'].every(k => typeof m[k] === 'string') ||
          !Number.isInteger(m.line) || !Number.isInteger(m.sourceStartLine) ||
          !Array.isArray(m.branches) || !m.branches.every(b => b && typeof b.label === 'string' && Number.isInteger(b.line)) ||
          !Array.isArray(m.rootIds) || !m.rootIds.every(id => functionIds.has(id)) ||
          !Array.isArray(m.lint) || !m.lint.every(v => typeof v === 'string') ||
          !(m.duplicateGroup === null || typeof m.duplicateGroup === 'string')) throw new Error('Invalid message in map.');
      messageIds.add(m.id);
    }
    for (const f of map.functions) {
      if (!f.calls.every(id => functionIds.has(id)) || !f.messageIds.every(id => messageIds.has(id)) ||
          !f.rootIds.every(id => functionIds.has(id))) throw new Error('Map contains broken references.');
    }
    if (!map.limitations.every(v => typeof v === 'string')) throw new Error('Invalid analysis notes.');
    return map;
  }
  function cleanReviews(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review object.');
    const result = Object.create(null);
    for (const [id, entry] of Object.entries(value)) {
      if (!messages.has(id)) continue;
      if (!entry || !['unreviewed', 'approved', 'flagged'].includes(entry.status) ||
          typeof entry.comment !== 'string') throw new Error('Invalid review entry.');
      result[id] = { status: entry.status, comment: entry.comment, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '' };
    }
    return result;
  }
  function load(map) {
    data = validateMap(map);
    model = Model.buildForest(data);
    functions = model.functions;
    messages = model.messages;
    roots = data.functions.filter(f => f.exported);
    searchText = new Map(data.messages.map(m => [m.id, [
      m.text, m.expression, m.file, functions.get(m.functionId).name, m.resolution,
      ...m.branches.map(b => b.label), ...m.rootIds.map(id => functions.get(id).name)
    ].join('\n').toLowerCase()]));
    datasetKey = `pstextviewer:review:${hash(data.name + '|' + [...new Set(data.functions.map(f => f.file))].sort().join('|'))}`;
    reviews = Object.create(null);
    visited = new Set();
    storageAvailable = true;
    try {
      const saved = localStorage.getItem(datasetKey);
      if (saved) reviews = cleanReviews(JSON.parse(saved));
      const savedVisits = JSON.parse(localStorage.getItem(`${datasetKey}:visited`) || '[]');
      if (!Array.isArray(savedVisits) || !savedVisits.every(key => typeof key === 'string')) throw new Error('Invalid visited-node data.');
      const validKeys = new Set([...model.nodes.values()].map(n => n.visitKey));
      visited = new Set(savedVisits.filter(key => validKeys.has(key)));
    } catch (error) {
      storageAvailable = false;
      toast(`Browser review storage unavailable or invalid. Export a backup. ${error.message}`);
    }
    for (const [id, review] of Object.entries(reviews)) {
      if (review.status !== 'unreviewed' || review.comment) Model.markVisited(model, visited, id);
    }
    Object.assign(state, { current: 'atlas', selected: null, query: '', kind: null, review: 'all', quality: 'all', duplicate: null, searchAll: false, history: [], showHelpers: false, limit: 400 });
    $('message-search').value = '';
    $('review-filter').value = 'all';
    $('quality-filter').value = 'all';
    $('workspace-name').textContent = data.name;
    $('workspace-name').title = data.sourcePath;
    document.title = `PSTextViewer / ${data.name}`;
    $('diagnostic-count').textContent = data.diagnostics.length ? `(${data.diagnostics.length})` : '';
    buildMiniMap();
    render();
    renderDetails();
  }
  function saveReview(id, patch) {
    reviews[id] = { ...reviewOf(id), ...patch, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(datasetKey, JSON.stringify(reviews));
      storageAvailable = true;
    } catch (error) {
      storageAvailable = false;
      toast(`Review is in memory only. Export a JSON backup. ${error.message}`);
    }
    const note = $('save-note');
    if (note) note.textContent = storageAvailable ? 'Saved in this browser. Export JSON to keep a portable backup.' : 'In memory only. Export JSON before closing this page.';
  }
  function persistVisits() {
    try { localStorage.setItem(`${datasetKey}:visited`, JSON.stringify([...visited])); }
    catch (error) { toast(`Visit history is in memory only. ${error.message}`); }
  }
  function visit(id) {
    Model.markVisited(model, visited, id);
    persistVisits();
  }
  function snapshot() {
    return {
      current: state.current, query: state.query, searchAll: state.searchAll,
      kind: state.kind, review: state.review, quality: state.quality, duplicate: state.duplicate,
      scroll: $('canvas').scrollTop, showHelpers: state.showHelpers
    };
  }
  function syncInputs() {
    $('message-search').value = state.query;
    $('review-filter').value = state.review;
    $('quality-filter').value = state.quality;
  }
  function animateLayer(direction) {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      $('journey').getAnimations().forEach(animation => animation.cancel());
      $('journey').animate([
        { opacity: 0, transform: `translateX(${direction * 18}px)` },
        { opacity: 1, transform: 'translateX(0)' }
      ], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  }
  function enter(id, direction = 1) {
    const node = model.nodes.get(id);
    if (!node) return;
    if (node.type === 'message') { selectMessage(id, true); return; }
    if (id !== state.current || state.query || state.searchAll) state.history.push(snapshot());
    state.current = id; state.selected = null; state.limit = 400;
    resetFilters(false);
    state.searchAll = false;
    visit(id);
    render(); renderDetails();
    $('canvas').scrollTop = 0;
    $('layer-title')?.focus({ preventScroll: true });
    animateLayer(direction);
    focusMiniNode(id);
  }
  function goBack() {
    const previous = state.history.pop();
    if (previous) { Object.assign(state, previous); syncInputs(); }
    else {
      const parent = model.nodes.get(state.current).parentId;
      state.current = parent || 'atlas';
      resetFilters(false); state.searchAll = false;
    }
    state.selected = null; state.limit = 400;
    render(); renderDetails();
    $('canvas').scrollTop = previous?.scroll || 0;
    $('layer-title')?.focus({ preventScroll: true });
    animateLayer(-1);
    focusMiniNode(state.current);
  }
  function isSearching() {
    return Boolean(state.query || state.kind || state.review !== 'all' || state.quality !== 'all' || state.duplicate || state.searchAll);
  }
  function passes(m) {
    return (!state.query || searchText.get(m.id).includes(state.query.toLowerCase())) &&
      (!state.kind || m.kind === state.kind) &&
      (state.review === 'all' || reviewOf(m.id).status === state.review) &&
      (!state.duplicate || m.duplicateGroup === state.duplicate) &&
      (state.quality === 'all' ||
        state.quality === 'lint' && m.lint.length ||
        state.quality === 'duplicates' && m.duplicateGroup ||
        state.quality === 'dynamic' && /dynamic|possible|ambiguous/.test(m.resolution) ||
        state.quality === 'unreachable' && !m.rootIds.length);
  }
  function renderMetrics() {
    const approved = data.messages.filter(m => reviewOf(m.id).status === 'approved').length;
    const flagged = data.messages.filter(m => reviewOf(m.id).status === 'flagged').length;
    const values = [
      [data.messages.length, 'Messages'], [roots.length, 'Entry points'],
      [flagged, 'Flagged'], [data.messages.length ? `${Math.round(approved / data.messages.length * 100)}%` : '0%', 'Approved']
    ];
    $('metrics').replaceChildren(...values.map(([value, label], i) => el('div', { class: `metric${i === 3 ? ' accent' : ''}` },
      el('strong', {}, typeof value === 'number' ? format(value) : value), el('span', {}, label))));
  }
  function renderFilters() {
    const counts = {};
    for (const m of data.messages) counts[m.kind] = (counts[m.kind] || 0) + 1;
    const all = button('All', `kind-filter${!state.kind ? ' active' : ''}`, () => { state.kind = null; renderMain(); }, { 'aria-pressed': String(!state.kind), style: { '--kind-color': 'var(--accent)' } });
    $('kind-filters').replaceChildren(all, ...Object.entries(counts).sort(([a], [b]) => Object.keys(kinds).indexOf(a) - Object.keys(kinds).indexOf(b)).map(([kind, count]) => {
      const b = button('', `kind-filter${state.kind === kind ? ' active' : ''}`, () => {
        state.kind = state.kind === kind ? null : kind; state.limit = 400; renderMain();
      }, { 'aria-pressed': String(state.kind === kind), style: { '--kind-color': kinds[kind]?.color || 'var(--muted)' } });
      b.append(el('i', { class: 'dot' }), kinds[kind]?.label || kind, el('span', { class: 'kind-count' }, count));
      return b;
    }));
    $('filter-indicator').textContent = state.review !== 'all' || state.quality !== 'all' || state.duplicate ? '•' : '';
  }
  function highlight(text) {
    const frag = document.createDocumentFragment();
    const query = state.query.toLowerCase();
    if (!query) { frag.append(document.createTextNode(text)); return frag; }
    let from = 0, index;
    const lower = text.toLowerCase();
    while ((index = lower.indexOf(query, from)) >= 0) {
      frag.append(document.createTextNode(text.slice(from, index)), el('mark', {}, text.slice(index, index + query.length)));
      from = index + query.length;
    }
    frag.append(document.createTextNode(text.slice(from)));
    return frag;
  }
  function messageCard(m) {
    const r = reviewOf(m.id);
    const b = button('', `message-card${state.selected === m.id ? ' selected' : ''}`, () => selectMessage(m.id), {
      'data-message-id': m.id, 'aria-pressed': String(state.selected === m.id), style: { '--kind-color': kinds[m.kind]?.color || 'var(--muted)' }
    });
    const top = el('div', { class: 'message-top' }, el('i', { class: 'dot' }), el('span', { class: 'kind-label' }, m.kind));
    if (m.lint.length) top.append(el('span', { class: 'lint-chip', title: m.lint.join('\n') }, `${m.lint.length} lint`));
    if (m.duplicateGroup) top.append(el('span', { class: 'lint-chip', title: 'Similar wording elsewhere' }, 'similar'));
    top.append(el('span', { class: `review-icon ${r.status}`, title: r.status }, r.status === 'approved' ? '✓' : r.status === 'flagged' ? '⚑' : '○'));
    const body = el('div', { class: 'message-body' }, top, el('div', { class: 'message-text' }, highlight(m.text)),
      el('div', { class: 'message-location' }, `${functions.get(m.functionId).name} · ${m.file}:${m.line}`));
    b.append(body);
    return b;
  }
  function renderCanvas() {
    const frag = document.createDocumentFragment();
    const node = model.nodes.get(state.current);
    if (isSearching()) {
      matching = data.messages.filter(passes);
      frag.append(layerHeading(state.duplicate ? 'Similar wording' : 'Messages', `${format(matching.length)} matches across all files`, 'SEARCH'));
      for (const m of matching.slice(0, state.limit)) frag.append(messageCard(m));
      if (!matching.length) frag.append(el('div', { class: 'empty-state' }, el('h2', {}, 'No matching messages.'), button('Clear filters', 'quiet', () => { state.searchAll = false; resetFilters(); })));
      if (matching.length > state.limit) frag.append(button('Show more messages', 'show-more', () => { state.limit += 400; renderCanvas(); }));
    } else if (node.type === 'atlas') {
      const files = state.showHelpers ? [...model.files.values()] : model.homeFiles;
      frag.append(layerHeading('Choose a file', 'Open a file, choose an entry point, then follow one code path at a time.', 'FILES'));
      const grid = el('div', { class: 'card-grid', 'data-level': 'files' });
      for (const file of files) grid.append(layerCard(file, `${file.entryIds.length} entry points · ${file.children.length} functions`, 'FILE'));
      if (!files.length) grid.append(el('p', { class: 'muted' }, 'No public entry points or module-level text found. Include internal functions to explore helper files.'));
      frag.append(grid);
    } else if (node.type === 'file') {
      frag.append(layerHeading(node.name, 'Choose an entry point or module-level text.', 'FILE'));
      const ids = state.showHelpers || !node.entryIds.length ? node.children : node.entryIds;
      const grid = el('div', { class: 'card-grid', 'data-level': 'entry-points' });
      for (const id of ids) {
        const f = model.nodes.get(id), source = functions.get(id);
        const label = f.scopeType === 'script' ? 'MODULE TEXT' : f.exported ? 'ENTRY POINT' : 'INTERNAL FUNCTION';
        grid.append(layerCard(f, `${source.messageIds.length} local messages · ${model.reach(id).size} reachable${source.rootIds.length > 1 ? ` · shared by ${source.rootIds.length} roots` : ''}`, label));
      }
      frag.append(grid);
    } else {
      const f = functions.get(node.functionId);
      frag.append(layerHeading(node.name, `${node.file}:${node.line}${node.type === 'function' && f.exportReason ? ` · ${f.exportReason}` : ''}`, node.type === 'branch' ? 'CODE PATH' : node.scopeType === 'script' ? 'MODULE TEXT' : 'FUNCTION'));
      const timeline = el('div', { class: 'timeline', 'data-level': 'code-path' });
      for (const step of node.steps.slice(0, state.limit)) {
        if (step.type === 'message') timeline.append(messageCard(messages.get(step.id)));
        else if (step.type === 'branch') {
          const branch = model.nodes.get(step.id);
          timeline.append(layerCard(branch, `${model.directMessages.get(branch.id).length} local messages · line ${branch.line}`, 'CODE PATH'));
        } else timeline.append(callCard(step));
      }
      if (!node.steps.length) timeline.append(el('p', { class: 'muted' }, 'No directly extracted text here. This function may only call other helpers.'));
      if (node.steps.length > state.limit) timeline.append(button('Show more steps', 'show-more', () => { state.limit += 400; renderCanvas(); }));
      frag.append(timeline);
    }
    $('journey').replaceChildren(frag);
  }
  function layerHeading(name, subtitle, kind) {
    return el('div', { class: 'layer-heading' }, el('span', { class: 'eyebrow' }, kind), el('h1', { id: 'layer-title', tabindex: '-1' }, name), el('p', {}, subtitle));
  }
  function layerCard(node, subtitle, label) {
    const summary = summaries.get(node.id);
    const b = button('', `layer-card ${summary.status}`, () => enter(node.id), { 'data-layer-id': node.id, 'data-node-type': node.type });
    b.append(el('div', { class: 'layer-card-top' }, el('span', { class: 'eyebrow' }, label),
      el('span', { class: `state-indicator ${summary.status}`, title: summary.complete ? 'Entire owned subtree visited' : summary.visited ? 'Visited; subtree not completely visited' : 'Not visited' }, summary.status === 'approved' ? 'Approved' : summary.status === 'flagged' ? `${summary.flagged} flagged` : summary.complete ? 'Visited' : `${summary.visitedCount}/${summary.nodeCount} visited`)),
      el('div', { class: 'layer-card-name' }, el('strong', {}, node.name), el('span', { class: 'enter-arrow', 'aria-hidden': 'true' }, '→')),
      el('p', { class: 'layer-card-meta' }, subtitle),
      el('div', { class: 'progress-track', 'aria-hidden': 'true' }, el('div', { class: 'progress-fill', style: { width: `${summary.visitedCount / summary.nodeCount * 100}%` } })));
    return b;
  }
  function callCard(step) {
    const target = model.nodes.get(step.targetId), source = functions.get(step.functionId);
    const crossFile = source.file !== target.file;
    const card = button('', 'call-card', () => enter(target.id), { 'data-call-target': target.id });
    card.append(el('span', { class: 'portal-icon', 'aria-hidden': 'true' }, crossFile ? '↗' : '↳'),
      el('span', { class: 'call-info' }, el('span', { class: 'eyebrow' }, crossFile ? 'JUMP TO FILE' : target.id === source.id ? 'RECURSIVE CALL' : 'CALL HELPER'),
        el('strong', {}, target.name), el('small', {}, `${target.file} · called at line ${step.line}${step.approximate ? ' (call location unavailable in older map)' : ''}`)),
      el('span', { class: 'counter' }, `${model.reach(target.id).size} messages`), el('span', { class: 'enter-arrow' }, '→'));
    return card;
  }
  function renderMain() {
    const node = model.nodes.get(state.current);
    const crumbs = Model.pathTo(model, node.id);
    $('breadcrumbs').replaceChildren(...crumbs.flatMap((id, i) => [
      i ? el('span', { class: 'crumb-separator' }, '/') : null,
      button(model.nodes.get(id).name, `crumb${i === crumbs.length - 1 ? ' active' : ''}`, () => enter(id, -1), { title: model.nodes.get(id).name })
    ]).filter(Boolean));
    $('back-button').disabled = !state.history.length && state.current === 'atlas' && !state.selected && !isSearching();
    $('include-helpers').hidden = !['atlas', 'file'].includes(node.type) || isSearching();
    $('include-helpers').textContent = node.type === 'atlas' ? 'Include helper-only files' : 'Include internal functions';
    $('include-helpers').setAttribute('aria-pressed', String(state.showHelpers));
    $('result-count').textContent = isSearching() ? `Global message search${state.query ? ` · “${state.query}”` : ''}` : `${summaries.get(node.id).visitedCount}/${summaries.get(node.id).nodeCount} nodes visited in this subtree`;
    renderFilters();
    renderCanvas();
  }
  function render() {
    summaries = Model.summarize(model, visited, reviews);
    renderMetrics(); renderMain(); updateMiniMap();
  }
  function selectMessage(id, fromMap = false) {
    const parent = model.nodes.get(id).parentId;
    if (fromMap || !isSearching()) {
      if (state.current !== parent) enter(parent);
    }
    state.selected = id;
    visit(id);
    summaries = Model.summarize(model, visited, reviews);
    for (const card of document.querySelectorAll('.message-card')) {
      const selected = card.dataset.messageId === id;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    }
    renderDetails();
    updateMiniMap();
    $('back-button').disabled = false;
    if (fromMap) [...document.querySelectorAll('[data-message-id]')].find(card => card.dataset.messageId === id)?.scrollIntoView({ block: 'center' });
    focusMiniNode(id);
  }
  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function buildMiniMap() {
    miniRects.clear(); miniEdges.clear();
    const fragment = document.createDocumentFragment();
    for (const file of [...model.files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const count = model.directMessages.get(file.id).length;
      const width = Math.max(150, Math.min(650, count * 5 + file.children.length * 5));
      const layout = Model.layoutTree(model, file.id, width * state.zoom, 112);
      const tree = el('div', { class: 'mini-tree', 'data-file': file.name });
      tree.append(button(file.name, 'mini-file-label', () => enter(file.id), { title: file.name }));
      const svg = svgEl('svg', { width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}`, role: 'group', 'aria-label': file.name });
      for (const edge of layout.edges) {
        const line = svgEl('path', { d: `M${edge.from.x},${edge.from.y + 2} V${(edge.from.y + edge.to.y) / 2} H${edge.to.x} V${edge.to.y - 2}`, class: 'mini-edge' });
        miniEdges.set(edge.to.id, line);
        svg.append(line);
      }
      for (const point of layout.points) {
        const node = model.nodes.get(point.id);
        const rect = svgEl('rect', {
          x: point.x - layout.boxWidth / 2, y: point.y - 2, width: layout.boxWidth, height: 4, rx: .4,
          class: 'mini-node', 'data-node-id': point.id, 'data-node-type': node.type, tabindex: node.type === 'file' ? '0' : '-1',
          role: 'button', 'aria-label': `${node.type}: ${node.name}`
        });
        const title = svgEl('title');
        title.textContent = `${node.type}: ${node.name}`;
        rect.append(title);
        rect.addEventListener('click', () => enter(point.id));
        rect.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); enter(point.id); }
          const siblings = model.nodes.get(node.parentId)?.children || [];
          const siblingIndex = siblings.indexOf(node.id);
          const target = event.key === 'ArrowUp' ? node.parentId : event.key === 'ArrowDown' ? node.children[0] :
            event.key === 'ArrowLeft' ? siblings[siblingIndex - 1] : event.key === 'ArrowRight' ? siblings[siblingIndex + 1] : null;
          if (target && miniRects.has(target)) { event.preventDefault(); miniRects.get(target).focus(); }
        });
        miniRects.set(point.id, rect);
        svg.append(rect);
      }
      tree.append(svg); fragment.append(tree);
    }
    $('mini-map').replaceChildren(fragment);
    updateMapGutters();
    if (state.current === 'atlas' && !state.selected) {
      $('mini-map').scrollLeft = Math.max(0, parseFloat($('mini-map').style.paddingLeft) - 22);
    }
  }
  function updateMiniMap() {
    const current = state.selected || state.current;
    const path = new Set(Model.pathTo(model, current));
    for (const [id, rect] of miniRects) {
      const summary = summaries.get(id), node = model.nodes.get(id);
      rect.setAttribute('class', `mini-node ${summary.status}${id === current ? ' current' : ''}`);
      rect.setAttribute('data-state', summary.status);
      rect.setAttribute('data-complete', String(summary.complete));
      rect.setAttribute('aria-current', id === current ? 'location' : 'false');
      rect.setAttribute('tabindex', node.type === 'file' || id === current ? '0' : '-1');
      rect.firstChild.textContent = `${node.type}: ${node.name}\n${summary.visitedCount}/${summary.nodeCount} visited · ${summary.approved}/${summary.total} approved${summary.flagged ? ` · ${summary.flagged} flagged` : ''}`;
    }
    for (const [id, edge] of miniEdges) edge.classList.toggle('on-path', path.has(id));
    for (const tree of $('mini-map').children) {
      tree.classList.toggle('active-tree', model.nodes.get(current)?.file === tree.dataset.file);
    }
  }
  function focusMiniNode(id) {
    const tree = miniRects.get(id)?.closest('.mini-tree');
    if (!tree) return;
    const strip = $('mini-map');
    const bounds = strip.getBoundingClientRect(), treeBounds = tree.getBoundingClientRect();
    strip.scrollTo({
      left: strip.scrollLeft + treeBounds.left + treeBounds.width / 2 - (bounds.left + strip.clientLeft + strip.clientWidth / 2),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  }
  function updateMapGutters() {
    const strip = $('mini-map');
    if (!strip.firstElementChild) return;
    // End gutters let even the first and last file trees reach the viewport center.
    strip.style.paddingLeft = `${Math.max(12, (strip.clientWidth - strip.firstElementChild.offsetWidth) / 2)}px`;
    strip.style.paddingRight = `${Math.max(12, (strip.clientWidth - strip.lastElementChild.offsetWidth) / 2)}px`;
  }
  function section(title, ...children) {
    return el('section', { class: 'detail-section' }, el('h3', {}, title), ...children);
  }
  function shortestRoute(rootId, targetId) {
    const queue = [rootId], prior = new Map([[rootId, null]]);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === targetId) {
        const result = [];
        for (let step = id; step !== null; step = prior.get(step)) result.unshift(step);
        return result;
      }
      for (const next of functions.get(id).calls) if (!prior.has(next)) { prior.set(next, id); queue.push(next); }
    }
    return [];
  }
  function renderDetails() {
    const panel = $('details');
    if (!state.selected || !messages.has(state.selected)) {
      panel.hidden = true;
      $('app-layout').classList.remove('has-inspector');
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    $('app-layout').classList.add('has-inspector');
    const m = messages.get(state.selected), f = functions.get(m.functionId), r = reviewOf(m.id);
    const heading = el('div', { class: 'detail-heading' }, el('h2', {}, 'Message inspector'),
      button('×', 'icon-button', () => { state.selected = null; renderDetails(); renderCanvas(); updateMiniMap(); }, { 'aria-label': 'Close message details' }));
    const preview = el('section', { class: 'detail-section' },
      el('div', { class: 'detail-kind', style: { '--kind-color': kinds[m.kind]?.color || 'var(--muted)' } },
        el('i', { class: 'dot' }), el('span', { class: 'kind-label' }, m.kind), el('span', { class: 'tag' }, m.resolution)),
      el('div', { class: 'message-preview' }, m.text),
      el('p', { class: 'resolution-note' }, /dynamic|possible|ambiguous/.test(m.resolution) ? 'Possible or unresolved text. Inspect the expression below; this is not a guaranteed runtime value.' : 'Template as written. Variables and expressions have not been executed.'));
    const statuses = el('div', { class: 'status-buttons' });
    for (const [status, label] of [['unreviewed', '○ Unreviewed'], ['approved', '✓ Approve'], ['flagged', '⚑ Flag']]) {
      statuses.append(button(label, status === r.status ? 'active' : '', () => {
        saveReview(m.id, { status });
        render();
        for (const b of statuses.children) { b.classList.toggle('active', b.dataset.status === status); b.setAttribute('aria-pressed', String(b.dataset.status === status)); }
      }, { 'data-status': status, 'aria-pressed': String(status === r.status) }));
    }
    const comment = el('textarea', { id: 'review-comment', placeholder: 'What should change? Leave a note...', 'aria-label': 'Review comment' });
    comment.value = r.comment;
    comment.addEventListener('input', () => saveReview(m.id, { comment: comment.value }));
    const review = section('Your review', statuses, comment,
      el('p', { class: 'saved-note', id: 'save-note' }, storageAvailable ? 'Saved in this browser. Export JSON to keep a portable backup.' : 'In memory only. Export JSON before closing this page.'));
    const source = section('Source', el('div', { class: 'source-location' }, `${m.file}:${m.line}:${m.column}\n${f.name}`));
    source.querySelector('h3').append(button('Copy expression', 'quiet', () => copy(m.expression)));
    source.append(button('Open code location →', 'quiet open-location', () => selectMessage(m.id, true)));
    const code = el('pre', { class: 'code-block' });
    for (const [index, text] of m.source.split('\n').entries()) {
      const number = m.sourceStartLine + index;
      code.append(el('div', { class: `code-line${number === m.line ? ' current' : ''}` }, el('span', { class: 'line-number' }, number), el('span', { class: 'code-text' }, text)));
    }
    source.append(code);
    const branches = section('Branch conditions');
    if (!m.branches.length) branches.append(el('p', { class: 'muted' }, 'No enclosing branch in this function.'));
    else for (const b of m.branches) branches.append(el('div', { class: 'branch-detail' }, b.label));
    const routes = section(`Reachable from ${m.rootIds.length} entry point${m.rootIds.length === 1 ? '' : 's'}`);
    if (!m.rootIds.length) routes.append(el('p', { class: 'muted' }, 'No static path from a known entry point. This may be an internal function, a dynamic call, a class method, or unused code.'));
    else {
      routes.append(el('p', { class: 'muted' }, 'One shortest static path per entry point. Other paths may exist.'));
      for (const rootId of m.rootIds.slice(0, 60)) {
        const path = shortestRoute(rootId, m.functionId);
        const route = el('div', { class: 'route' });
        route.append(button(functions.get(rootId).name, '', () => {
          enter(rootId);
        }));
        for (const id of path.slice(1)) route.append(el('span', { class: 'route-hop' }, functions.get(id).name));
        routes.append(route);
      }
      if (m.rootIds.length > 60) routes.append(el('p', { class: 'muted' }, `${m.rootIds.length - 60} more entry points; use exported cmdlet search.`));
    }
    const quality = section('Wording signals');
    if (m.lint.length) quality.append(el('ul', { class: 'lint-list' }, ...m.lint.map(text => el('li', {}, text))));
    else quality.append(el('p', { class: 'muted' }, 'No heuristic lint suggestions. Human review still matters.'));
    if (m.duplicateGroup) {
      const count = data.messages.filter(other => other.duplicateGroup === m.duplicateGroup).length;
      quality.append(button(`Compare ${count} similar messages →`, 'duplicate-button', () => {
        resetFilters(false); state.duplicate = m.duplicateGroup; state.searchAll = true; render();
      }));
    }
    panel.replaceChildren(heading, preview, review);
    const sample = sampleSection(m);
    if (sample) panel.append(sample);
    panel.append(source, branches, routes, quality);
  }
  function sampleSection(m) {
    const pattern = /\$\([^)]*\)|\$\{[^}]+\}|\$[a-zA-Z_][\w:.]*|\{\d+(?:[^{}]*)\}/g;
    const slots = [...new Set(m.text.match(pattern) || [])].slice(0, 12);
    if (!slots.length) return null;
    const inputs = el('div', { class: 'sample-inputs' });
    const preview = el('div', { class: 'sample-preview' });
    const values = new Map(slots.map((slot, i) => [slot, `sample-${i + 1}`]));
    const update = () => { preview.textContent = m.text.replace(pattern, match => values.get(match) ?? match); };
    for (const slot of slots) {
      const input = el('input', { 'aria-label': `Sample value for ${slot}` });
      input.value = values.get(slot);
      input.addEventListener('input', () => { values.set(slot, input.value); update(); });
      inputs.append(el('label', {}, slot, input));
    }
    update();
    return section('Try sample values', el('p', { class: 'muted' }, 'Illustrative substitution only. No PowerShell evaluation or format specifier execution.'), inputs, preview);
  }
  function resetFilters(doRender = true) {
    Object.assign(state, { query: '', kind: null, review: 'all', quality: 'all', duplicate: null, limit: 400 });
    $('message-search').value = ''; $('review-filter').value = 'all'; $('quality-filter').value = 'all';
    if (doRender) render();
  }
  function copy(text) {
    if (window.navigator.clipboard?.writeText) {
      window.navigator.clipboard.writeText(text).then(() => toast('Expression copied.'), () => copyFallback(text));
    } else copyFallback(text);
  }
  function copyFallback(text) {
    const input = el('textarea', { 'aria-label': 'Copy expression' });
    input.value = text; document.body.append(input); input.select();
    try { toast(document.execCommand('copy') ? 'Expression copied.' : 'Copy unavailable in this browser. Select source text instead.'); }
    catch { toast('Copy unavailable in this browser. Select source text instead.'); }
    finally { input.remove(); }
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function exportCsv() {
    const columns = ['id', 'status', 'comment', 'kind', 'text', 'function', 'file', 'line', 'resolution', 'branches', 'entryPoints', 'lint', 'expression'];
    const rows = data.messages.map(m => {
      const r = reviewOf(m.id);
      return [m.id, r.status, r.comment, m.kind, m.text, functions.get(m.functionId).name, m.file, m.line, m.resolution,
        m.branches.map(b => b.label).join(' → '), m.rootIds.map(id => functions.get(id).name).join('; '), m.lint.join('; '), m.expression];
    });
    download('pstextviewer-review.csv', '\uFEFF' + [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    toast(`Exported ${format(rows.length)} messages with review annotations.`);
  }
  function openAnalysis() {
    const content = $('analysis-content');
    content.replaceChildren(el('p', {}, `${data.sourcePath}\nGenerated ${new Date(data.generatedAt).toLocaleString()}`),
      el('ul', {}, ...data.limitations.map(text => el('li', {}, text))));
    if (data.diagnostics.length) content.append(el('h3', {}, `${format(data.diagnostics.length)} diagnostics`));
    for (const d of data.diagnostics.slice(0, 200)) content.append(el('div', { class: 'analysis-diagnostic' }, `${d.severity} · ${d.file}:${d.line}\n${d.message}`));
    if (data.diagnostics.length > 200) content.append(el('p', {}, 'Showing first 200. The JSON map includes all diagnostics.'));
    if (data.dynamicCalls?.length) {
      content.append(el('h3', {}, `${format(data.dynamicCalls.length)} dynamic invocations: paths may be incomplete`));
      for (const call of data.dynamicCalls.slice(0, 30)) content.append(el('div', { class: 'analysis-diagnostic' }, `${call.file}:${call.line}\n${call.expression}`));
      if (data.dynamicCalls.length > 30) content.append(el('p', {}, 'Showing first 30. The JSON map includes all dynamic invocations.'));
    }
    $('analysis-dialog').showModal();
  }
  function debounce(action, delay = 130) {
    let timer;
    return (...args) => { window.clearTimeout(timer); timer = window.setTimeout(() => action(...args), delay); };
  }
  $('message-search').addEventListener('input', debounce(() => {
    state.query = $('message-search').value.trim();
    state.limit = 400; renderMain();
  }));
  $('back-button').addEventListener('click', goBack);
  $('home-button').addEventListener('click', () => enter('atlas', -1));
  $('include-helpers').addEventListener('click', () => { state.showHelpers = !state.showHelpers; renderMain(); });
  $('all-messages').addEventListener('click', () => {
    state.history.push(snapshot()); resetFilters(false); state.searchAll = true;
    state.selected = null; render(); renderDetails(); animateLayer(1);
  });
  $('clear-search').addEventListener('click', () => { state.query = ''; $('message-search').value = ''; renderMain(); $('message-search').focus(); });
  $('more-filters').addEventListener('click', () => { $('advanced-filters').hidden = !$('advanced-filters').hidden; });
  $('review-filter').addEventListener('change', event => { state.review = event.target.value; renderMain(); });
  $('quality-filter').addEventListener('change', event => { state.quality = event.target.value; render(); });
  $('reset-filters').addEventListener('click', () => resetFilters());
  function zoom(delta) {
    state.zoom = Math.max(.5, Math.min(4, Math.round((state.zoom + delta) * 10) / 10));
    buildMiniMap(); updateMiniMap();
    focusMiniNode(state.selected || state.current);
    $('zoom-value').textContent = `${Math.round(state.zoom * 100)}%`;
  }
  $('zoom-in').addEventListener('click', () => zoom(.1));
  $('zoom-out').addEventListener('click', () => zoom(-.1));
  $('mini-map').addEventListener('wheel', event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoom(event.deltaY > 0 ? -.1 : .1); } }, { passive: false });
  new window.ResizeObserver(() => {
    if (!model) return;
    updateMapGutters();
    focusMiniNode(state.selected || state.current);
  }).observe($('mini-map'), { box: 'border-box' });
  $('analysis-button').addEventListener('click', openAnalysis);
  $('close-analysis').addEventListener('click', () => $('analysis-dialog').close());
  $('export-button').addEventListener('click', () => $('export-dialog').showModal());
  $('close-export').addEventListener('click', () => $('export-dialog').close());
  $('download-csv').addEventListener('click', exportCsv);
  $('download-review').addEventListener('click', () => download('pstextviewer-review.json',
    JSON.stringify({ schemaVersion: 1, datasetKey, generatedAt: new Date().toISOString(), reviews, visited: [...visited] }, null, 2), 'application/json'));
  $('import-review').addEventListener('click', () => $('review-input').click());
  $('load-data').addEventListener('click', () => $('data-input').click());
  $('data-input').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const map = validateMap(JSON.parse(await file.text()));
      load(map); toast(`Opened ${map.name}.`);
    } catch (error) { toast(`Could not open map: ${error.message}`); }
    event.target.value = '';
  });
  $('review-input').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup.schemaVersion !== 1 || !backup.reviews) throw new Error('Not a v1 review backup.');
      const imported = cleanReviews(backup.reviews), count = Object.keys(imported).length;
      if (backup.visited !== undefined && (!Array.isArray(backup.visited) || !backup.visited.every(key => typeof key === 'string'))) throw new Error('Invalid visit history in backup.');
      const validKeys = new Set([...model.nodes.values()].map(n => n.visitKey));
      const importedVisits = (backup.visited || []).filter(key => validKeys.has(key));
      if (!count && !importedVisits.length) throw new Error('No message IDs or visited nodes match this map.');
      Object.assign(reviews, imported);
      for (const key of importedVisits) visited.add(key);
      for (const [id, review] of Object.entries(imported)) if (review.status !== 'unreviewed' || review.comment) Model.markVisited(model, visited, id);
      try {
        localStorage.setItem(datasetKey, JSON.stringify(reviews));
        localStorage.setItem(`${datasetKey}:visited`, JSON.stringify([...visited]));
        storageAvailable = true;
      }
      catch { storageAvailable = false; }
      render(); renderDetails();
      toast(`Imported ${count} matching annotations.${backup.datasetKey !== datasetKey ? ' Backup was from another map.' : ''}${storageAvailable ? '' : ' In memory only; export before closing.'}`);
    } catch (error) { toast(`Could not import review: ${error.message}`); }
    event.target.value = '';
  });
  $('theme-button').addEventListener('click', () => {
    document.body.classList.toggle('light');
    try { localStorage.setItem('pstextviewer:theme', document.body.classList.contains('light') ? 'light' : 'dark'); }
    catch { toast('Theme changed for this session; browser storage is unavailable.'); }
  });
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); enter('atlas', -1); });
  document.addEventListener('keydown', event => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) { event.preventDefault(); $('message-search').focus(); }
    if ((event.altKey && event.key === 'ArrowLeft' || event.key === 'Backspace' && !typing) && !document.querySelector('dialog[open]')) {
      event.preventDefault(); goBack();
    }
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !typing) {
      if (state.selected) { state.selected = null; renderDetails(); renderMain(); updateMiniMap(); }
      else if (isSearching()) { state.searchAll = false; resetFilters(); }
      else goBack();
    }
  });
  try { if (localStorage.getItem('pstextviewer:theme') === 'light') document.body.classList.add('light'); }
  catch { /* Loading the map reports unavailable review storage. */ }
  try { load(JSON.parse($('map-data').textContent)); }
  catch (error) {
    $('details').replaceChildren(el('div', { class: 'empty-state' }, el('h2', {}, 'No valid map loaded'), el('p', {}, error.message)));
    toast('Generate a viewer with Export-PSTextMap.ps1, or use Open map to load its JSON.');
  }
})();
