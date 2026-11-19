(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PSTextModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function buildForest(data) {
    const functions = new Map(data.functions.map(f => [f.id, f]));
    const messages = new Map(data.messages.map(m => [m.id, m]));
    const nodes = new Map();
    const reachCache = new Map();
    function reach(id) {
      if (reachCache.has(id)) return reachCache.get(id);
      const seen = new Set(), result = new Set(), queue = [id];
      for (let i = 0; i < queue.length; i++) {
        if (seen.has(queue[i])) continue;
        seen.add(queue[i]);
        const f = functions.get(queue[i]);
        for (const mid of f.messageIds) result.add(mid);
        queue.push(...f.calls);
      }
      reachCache.set(id, result);
      return result;
    }
    function add(node) {
      node.children = [];
      node.steps = [];
      nodes.set(node.id, node);
      if (node.parentId) nodes.get(node.parentId).children.push(node.id);
      return node;
    }
    add({ id: 'atlas', type: 'atlas', name: 'Files', parentId: null, visitKey: 'atlas', line: 0 });
    const files = new Map();
    const active = data.functions.filter(f => reach(f.id).size > 0);
    for (const f of active) {
      if (!files.has(f.file)) {
        const file = add({
          id: `file:${f.file}`, type: 'file', name: f.file, file: f.file, parentId: 'atlas',
          visitKey: `file:${f.file}`, line: 0, entryIds: []
        });
        files.set(f.file, file);
      }
      const file = files.get(f.file);
      const name = f.scopeType === 'script' ? 'Module-level text' : f.name;
      const node = add({
        id: f.id, type: 'function', name, file: f.file, line: f.line, functionId: f.id,
        parentId: file.id, visitKey: `function:${f.file}|${f.scopeType}|${f.name}|${f.line}`,
        exported: f.exported, scopeType: f.scopeType, exportReason: f.exportReason
      });
      if (f.scopeType !== 'script' && f.exported || f.scopeType === 'script' && f.messageIds.length) file.entryIds.push(node.id);
    }
    function branchParent(functionId, branches) {
      let parent = nodes.get(functionId);
      for (const b of branches) {
        const location = Number.isInteger(b.offset) ? b.offset : `${b.line}:${b.column || 0}`;
        const id = `${parent.id}/branch:${location}:${b.label}`;
        if (!nodes.has(id)) {
          const branch = add({
            id, type: 'branch', name: b.label, file: parent.file, functionId, line: b.line,
            column: b.column || 0, parentId: parent.id, visitKey: id
          });
          parent.steps.push({ type: 'branch', id: branch.id, line: b.line, column: b.column || 0 });
        }
        parent = nodes.get(id);
      }
      return parent;
    }
    for (const m of data.messages) {
      const parent = branchParent(m.functionId, m.branches);
      add({
        id: m.id, type: 'message', name: m.text, file: m.file, functionId: m.functionId,
        line: m.line, parentId: parent.id, visitKey: m.id, messageId: m.id
      });
      parent.steps.push({ type: 'message', id: m.id, line: m.line, column: m.column || 0 });
    }
    const callSites = data.callSites || data.functions.flatMap(f => f.calls.map(targetId => ({
      functionId: f.id, targetId, file: f.file, line: f.line, column: 0, branches: [],
      expression: functions.get(targetId).name, approximate: true
    })));
    for (const [index, call] of callSites.entries()) {
      if (!nodes.has(call.functionId) || !nodes.has(call.targetId)) continue;
      const parent = branchParent(call.functionId, call.branches);
      // Calls are portals, never ownership edges. Recursion cannot make the forest circular.
      parent.steps.push({ ...call, type: 'call', id: `call:${index}`, targetId: call.targetId });
    }
    for (const node of nodes.values()) {
      node.steps.sort((a, b) => a.line - b.line || (a.column || 0) - (b.column || 0));
      node.children.sort((a, b) => nodes.get(a).line - nodes.get(b).line || a.localeCompare(b));
    }
    nodes.get('atlas').children.sort((a, b) => nodes.get(a).file.localeCompare(nodes.get(b).file));
    const directMessages = new Map();
    function collect(id) {
      const node = nodes.get(id);
      const result = node.type === 'message' ? [id] : node.children.flatMap(collect);
      directMessages.set(id, result);
      return result;
    }
    collect('atlas');
    return {
      nodes, files, functions, messages, reach, directMessages,
      homeFiles: [...files.values()].filter(f => f.entryIds.length)
    };
  }

  function pathTo(model, id) {
    const path = [];
    for (let node = model.nodes.get(id); node; node = model.nodes.get(node.parentId)) path.unshift(node.id);
    return path;
  }

  function markVisited(model, visited, id) {
    for (const ancestor of pathTo(model, id)) visited.add(model.nodes.get(ancestor).visitKey);
  }

  function summarize(model, visited, reviews) {
    const result = new Map();
    function walk(id) {
      const node = model.nodes.get(id);
      const children = node.children.map(walk);
      const ownReview = node.type === 'message' ? reviews[node.id]?.status : null;
      const total = node.type === 'message' ? 1 : children.reduce((n, child) => n + child.total, 0);
      const approved = ownReview === 'approved' ? 1 : children.reduce((n, child) => n + child.approved, 0);
      const flagged = ownReview === 'flagged' ? 1 : children.reduce((n, child) => n + child.flagged, 0);
      const ownVisited = visited.has(node.visitKey);
      const visitedCount = (ownVisited ? 1 : 0) + children.reduce((n, child) => n + child.visitedCount, 0);
      const nodeCount = 1 + children.reduce((n, child) => n + child.nodeCount, 0);
      const complete = ownVisited && children.every(child => child.complete);
      const status = flagged ? 'flagged' : total > 0 && approved === total && complete ? 'approved' : ownVisited ? 'viewed' : 'unseen';
      const summary = { total, approved, flagged, complete, status, visited: ownVisited, visitedCount, nodeCount };
      result.set(id, summary);
      return summary;
    }
    walk('atlas');
    return result;
  }

  function layoutTree(model, id, width = 300, height = 120) {
    const points = [], edges = [];
    let leaves = 0, maxDepth = 0;
    function walk(nodeId, depth) {
      const node = model.nodes.get(nodeId);
      maxDepth = Math.max(maxDepth, depth);
      const childPoints = node.children.map(child => walk(child, depth + 1));
      const x = childPoints.length ? childPoints.reduce((n, p) => n + p.x, 0) / childPoints.length : leaves++;
      const point = { id: nodeId, x, depth };
      points.push(point);
      for (const child of childPoints) edges.push({ from: point, to: child });
      return point;
    }
    walk(id, 0);
    const spacing = (width - 16) / Math.max(1, leaves);
    for (const point of points) {
      point.x = 8 + (point.x + .5) * spacing;
      point.y = 7 + point.depth * ((height - 14) / Math.max(1, maxDepth));
    }
    return { points, edges, boxWidth: Math.min(7, spacing * .72), width, height, leaves, maxDepth };
  }

  return { buildForest, pathTo, markVisited, summarize, layoutTree };
});
