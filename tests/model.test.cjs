const { test } = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../web/model.js');

function fixture() {
  const scope = (id, name, file, exported, calls, messageIds, scopeType = 'function') => ({
    id, name, file, line: 1, scopeType, parentId: '', exportReason: '', exported, calls, messageIds, rootIds: []
  });
  const message = (id, functionId, text, branches = []) => ({
    id, functionId, text, file: functionId === 'shared' ? 'Utilities.psm1' : 'Public.psm1',
    line: id === 'second' ? 9 : 3, column: 1, branches
  });
  return {
    functions: [
      scope('get', 'Get-Widget', 'Public.psm1', true, ['shared'], ['first', 'second']),
      scope('set', 'Set-Widget', 'Public.psm1', true, ['shared'], []),
      scope('shared', 'Invoke-Shared', 'Utilities.psm1', false, ['shared'], ['remote']),
      scope('script', '<script>', 'Startup.ps1', true, [], ['startup'], 'script'),
      scope('empty', 'Unrelated-Empty', 'Empty.psm1', false, [], [])
    ],
    messages: [
      message('first', 'get', 'First', [{ label: 'if ($Name)', line: 2, offset: 10 }]),
      message('second', 'get', 'Second', [{ label: 'else', line: 8, offset: 90 }]),
      message('remote', 'shared', 'Shared'),
      { ...message('startup', 'script', 'Startup'), file: 'Startup.ps1' }
    ],
    callSites: [
      { functionId: 'get', targetId: 'shared', line: 4, column: 1, branches: [{ label: 'if ($Name)', line: 2, offset: 10 }], expression: 'Invoke-Shared' },
      { functionId: 'set', targetId: 'shared', line: 2, branches: [], expression: 'Invoke-Shared' },
      { functionId: 'shared', targetId: 'shared', line: 5, branches: [], expression: 'Invoke-Shared' }
    ]
  };
}
test('canonical forest has one function per source definition and no call cycles', () => {
  const model = Model.buildForest(fixture());
  assert.equal([...model.nodes.values()].filter(n => n.id === 'shared').length, 1);
  assert.equal(model.nodes.get('shared').parentId, 'file:Utilities.psm1');
  assert(!model.nodes.has('empty'));
  assert.deepEqual(model.homeFiles.map(f => f.file).sort(), ['Public.psm1', 'Startup.ps1']);
  const seen = new Set();
  function walk(id) {
    assert(!seen.has(id), `Repeated/cyclic ownership node: ${id}`);
    seen.add(id);
    for (const child of model.nodes.get(id).children) {
      assert.equal(model.nodes.get(child).parentId, id);
      walk(child);
    }
  }
  walk('atlas');
  assert.equal(seen.size, model.nodes.size);
  assert(model.reach('get').has('remote'));
  const branch = model.nodes.get(model.nodes.get('first').parentId);
  assert.deepEqual(branch.steps.map(step => step.type), ['message', 'call']);
  assert.equal(branch.steps[1].targetId, 'shared');
  assert(!branch.children.includes('shared'));
});
test('visited containers stay outlined without completing their unvisited subtrees', () => {
  const model = Model.buildForest(fixture()), visited = new Set();
  Model.markVisited(model, visited, 'get');
  let summary = Model.summarize(model, visited, {});
  assert.equal(summary.get('get').complete, false);
  assert.equal(summary.get('file:Public.psm1').status, 'viewed');
  assert.equal(summary.get('get').status, 'viewed');
  assert.equal(summary.get('shared').status, 'unseen');
  assert.equal(summary.get('first').status, 'unseen');
  Model.markVisited(model, visited, 'first');
  summary = Model.summarize(model, visited, { first: { status: 'approved' } });
  assert.equal(summary.get('get').complete, false);
  assert.equal(summary.get('get').status, 'viewed');
  assert.equal(summary.get('second').status, 'unseen');
  Model.markVisited(model, visited, 'second');
  summary = Model.summarize(model, visited, {});
  assert.equal(summary.get('get').status, 'viewed');
  assert.equal(summary.get('file:Public.psm1').complete, false, 'Set-Widget has not been visited');
  Model.markVisited(model, visited, 'set');
  summary = Model.summarize(model, visited, {});
  assert.equal(summary.get('file:Public.psm1').status, 'viewed');
  assert.equal(summary.get('shared').complete, false, 'Remote call targets belong to another subtree');
});
test('flagged propagates immediately; approved requires all local text and complete traversal', () => {
  const model = Model.buildForest(fixture()), visited = new Set();
  Model.markVisited(model, visited, 'first');
  let summary = Model.summarize(model, visited, { first: { status: 'flagged' } });
  assert.equal(summary.get('file:Public.psm1').status, 'flagged');
  assert.equal(summary.get('file:Utilities.psm1').status, 'unseen');
  const reviews = { first: { status: 'approved' }, second: { status: 'approved' } };
  summary = Model.summarize(model, visited, reviews);
  assert.equal(summary.get('get').status, 'viewed');
  Model.markVisited(model, visited, 'second');
  Model.markVisited(model, visited, 'set');
  summary = Model.summarize(model, visited, reviews);
  assert.equal(summary.get('get').status, 'approved');
  assert.equal(summary.get('file:Public.psm1').status, 'approved');
});
test('layout places every node once with finite coordinates and increasing depth', () => {
  const model = Model.buildForest(fixture());
  const layout = Model.layoutTree(model, 'file:Public.psm1');
  assert.equal(new Set(layout.points.map(p => p.id)).size, layout.points.length);
  for (const point of layout.points) assert(Number.isFinite(point.x) && Number.isFinite(point.y));
  for (const edge of layout.edges) assert(edge.to.y > edge.from.y);
  assert.deepEqual(Model.pathTo(model, 'first').slice(0, 3), ['atlas', 'file:Public.psm1', 'get']);
});
test('old maps keep call portals without fabricating source positions or duplicate helper trees', () => {
  const data = fixture();
  delete data.callSites;
  const model = Model.buildForest(data);
  const call = model.nodes.get('set').steps.find(step => step.type === 'call');
  assert(call.approximate);
  assert.equal(call.targetId, 'shared');
  assert.equal(model.nodes.get('shared').parentId, 'file:Utilities.psm1');
});
