const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const output = path.join(project, 'out', 'fixture');
let map, temporary;
function extract(source, destination, extra = []) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(project, 'Export-PSTextMap.ps1'),
    '-Path', source, '-OutputPath', destination, ...extra], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(destination, 'pstextmap.json'), 'utf8'));
}
before(() => {
  fs.rmSync(output, { recursive: true, force: true });
  map = extract(path.join(__dirname, 'fixtures'), output, ['-TraceCommand', 'Trace-Widget']);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pstextviewer-test-'));
});
after(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });
const getFunction = name => map.functions.find(f => f.name === name);
const findMessage = text => map.messages.find(m => m.text === text);

test('parses rather than executes module and extracts each supported stream', () => {
  assert(findMessage('FIXTURE MUST NEVER EXECUTE'));
  for (const kind of ['synopsis', 'description', 'parameter', 'example', 'throw', 'error', 'warning', 'verbose', 'debug', 'information', 'prompt', 'exception', 'trace']) {
    assert(map.messages.some(m => m.kind === kind), `Missing ${kind}`);
  }
  assert.equal(map.stats.parseErrors, 0);
  assert(findMessage('Warning via static alias.'));
  assert(findMessage('Legacy exception text.'));
  assert.equal(findMessage('[rethrow current exception]').resolution, 'dynamic');
  assert(!findMessage('Gets a widget.').expression.includes('function Get-Widget'));
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'Sample.psm1'), 'utf8').split('\n');
  assert(lines[findMessage('Gets a widget.').line - 1].includes('.SYNOPSIS'));
});
test('exports, shared helper reachability, recursion and nested scope are correct', () => {
  const shared = getFunction('Invoke-Shared');
  const roots = shared.rootIds.map(id => map.functions.find(f => f.id === id).name);
  assert.deepEqual(roots.sort(), ['Get-Widget', 'Set-Widget']);
  assert(getFunction('Get-Widget').exported);
  assert(!shared.exported);
  assert(getFunction('Invoke-Cycle').calls.includes(shared.id));
  assert.deepEqual(findMessage('An orphaned warning.').rootIds, []);
  assert.equal(findMessage('Only belongs to nested function.').functionId, getFunction('Invoke-Nested').id);
  assert(!getFunction('Invoke-Unreachable').messageIds.includes(findMessage('Only belongs to nested function.').id));
});
test('records branch paths, source positions and dynamic invocations', () => {
  const caught = findMessage('Cannot read widget.');
  assert(caught.branches.some(b => b.label.includes('catch [System.IO.IOException]')));
  assert(caught.branches.some(b => b.label === 'if (-not $Force)'));
  assert(findMessage('No widget name.').branches.some(b => b.label.startsWith('else (not:')));
  assert(findMessage('Forced widget lookup.').branches.some(b => b.label.startsWith('elseif')));
  assert(findMessage('Legacy widget.').branches.some(b => b.label.includes("switch ($Name): 'legacy'")));
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'Sample.psm1'), 'utf8').split('\n');
  assert(lines[caught.line - 1].includes('Cannot read widget.'));
  assert(caught.source.includes('catch [System.IO.IOException]'));
  assert(map.dynamicCalls.some(c => c.expression.includes('$dynamicCommand')));
  const call = map.callSites.find(c => c.functionId === getFunction('Get-Widget').id && c.targetId === getFunction('Invoke-RemoteHelper').id);
  assert(call.branches.some(b => b.label === 'if ($Name)'));
  assert(lines[call.line - 1].includes('Invoke-RemoteHelper'));
  assert(findMessage("Widget '$Name' was not found.").branches.some(b => b.label === 'try'));
  assert(call.branches.every(b => Number.isInteger(b.offset)));
});
test('resolves localization and assignments without claiming data-flow proof', () => {
  assert.equal(findMessage('The widget is not available.').resolution, 'localized: missingwidget');
  assert.match(findMessage('Unable to update $Name.').resolution, /possible assignment/);
  assert.match(findMessage('A shared warning.').resolution, /possible assignment/);
  assert(map.messages.some(m => m.expression.includes('ThrowTerminatingError') && m.resolution === 'dynamic'));
});
test('lint checks format bounds without flagging escaped braces', () => {
  assert(findMessage('Widget {1} cannot be updated.').lint.some(s => s.startsWith('Format placeholder')));
  assert(!findMessage('Escaped {{1}} and {0}.').lint.some(s => s.startsWith('Format placeholder')));
  const error = findMessage('Error: Could not update widget!!');
  assert(error.lint.includes('Redundant "Error:" prefix'));
  assert(error.lint.includes('Repeated terminal punctuation'));
});
test('manifest wildcards, malformed files, exclusions and safe HTML embedding', () => {
  const source = path.join(temporary, 'manifest');
  fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Widget.psm1'), `function Get-One { Write-Warning '</script><img src=x onerror=alert(1)>' }\nfunction Set-Two { Write-Debug 'private' }\n`);
  fs.writeFileSync(path.join(source, 'Widget.psd1'), `@{ RootModule = 'Widget.psm1'; FunctionsToExport = @('Get-*') }`);
  fs.writeFileSync(path.join(source, 'Broken.ps1'), 'function Bad {');
  fs.writeFileSync(path.join(source, 'node_modules', 'Ignore.ps1'), "throw 'not part of map'");
  const dest = path.join(temporary, 'manifest-out');
  const result = extract(source, dest);
  assert(result.functions.find(f => f.name === 'Get-One').exported);
  assert(!result.functions.find(f => f.name === 'Set-Two').exported);
  assert(result.diagnostics.some(d => d.file === 'Broken.ps1'));
  assert.equal(result.stats.files, 3);
  const html = fs.readFileSync(path.join(dest, 'PSTextViewer.html'), 'utf8');
  assert(!html.includes('</script><img'));
  assert(html.includes('\\u003c/script\\u003e'));
  assert(!html.includes('/*__APP__*/'));
});
test('message IDs survive unrelated line shifts and duplicate groups connect variants', () => {
  const source = path.join(temporary, 'stable');
  fs.mkdirSync(source);
  const file = path.join(source, 'Module.psm1');
  const code = `function Get-Test { Write-Warning "Unable to find $Name."; Write-Warning "unable to find $Widget!" }`;
  fs.writeFileSync(file, code);
  const first = extract(source, path.join(temporary, 'stable-one'));
  fs.writeFileSync(file, `\n\n# unrelated comment\n${code}`);
  const second = extract(source, path.join(temporary, 'stable-two'));
  assert.deepEqual(first.messages.map(m => m.id), second.messages.map(m => m.id));
  assert(first.messages[0].duplicateGroup);
  assert.equal(first.messages[0].duplicateGroup, first.messages[1].duplicateGroup);
  assert.match(first.functions.find(f => f.name === 'Get-Test').exportReason, /inferred/);
});
test('script scope does not collide with a function that starts at offset zero', () => {
  const source = path.join(temporary, 'scope');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Module.psm1'), `function Get-One { Write-Warning 'inside function' }\nWrite-Warning 'outside function'\nGet-One\nExport-ModuleMember -Function Get-One`);
  const result = extract(source, path.join(temporary, 'scope-out'));
  const outer = result.messages.find(m => m.text === 'outside function');
  const script = result.functions.find(f => f.id === outer.functionId);
  assert.equal(script.scopeType, 'script');
  assert.equal(result.functions.find(f => f.name === 'Get-One').calls.length, 0);
  assert(script.calls.includes(result.functions.find(f => f.name === 'Get-One').id));
});
