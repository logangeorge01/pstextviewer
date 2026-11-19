const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const project = path.resolve(__dirname, '..', '..');
const viewer = pathToFileURL(path.join(project, 'out', 'fixture', 'PSTextViewer.html')).href;
const fixtureMap = () => JSON.parse(fs.readFileSync(path.join(project, 'out', 'fixture', 'pstextmap.json'), 'utf8'));
const functionId = name => fixtureMap().functions.find(f => f.name === name).id;
const layer = (page, name) => page.locator('#journey .layer-card').filter({ has: page.locator('.layer-card-name strong', { hasText: name }) });

test.beforeEach(async ({ page }) => {
  await page.goto(viewer);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('#layer-title')).toHaveText('Choose a file');
});

test('header metrics, file-first layers, local branches, helper portals and back navigation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await expect(page.locator('.topbar #metrics')).toBeVisible();
  await expect(page.getByText('Every message.')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.locator('#details')).toBeHidden();
  await expect(layer(page, 'Utilities.psm1')).toHaveCount(0);
  await expect(layer(page, 'Bootstrap.ps1')).toBeVisible();
  await expect(page.locator('.mini-tree[data-file="Utilities.psm1"]')).toHaveCount(1);
  await layer(page, 'Sample.psm1').click();
  await expect(page.locator('#layer-title')).toHaveText('Sample.psm1');
  await expect(layer(page, 'Module-level text')).toBeVisible();
  await layer(page, 'Get-Widget').click();
  await expect(page.locator('#layer-title')).toHaveText('Get-Widget');
  await expect(page.locator('#details')).toBeHidden();
  await layer(page, 'if ($Name)').click();
  await expect(page.locator('#layer-title')).toHaveText('if ($Name)');
  await page.locator(`[data-call-target="${functionId('Invoke-RemoteHelper')}"]`).click();
  await expect(page.locator('#layer-title')).toHaveText('Invoke-RemoteHelper');
  await expect(page.locator('#breadcrumbs')).toContainText('Utilities.psm1');
  await expect(page.locator(`.mini-node[data-node-id="${functionId('Invoke-RemoteHelper')}"]`)).toHaveCount(1);
  await page.locator('#back-button').click();
  await expect(page.locator('#layer-title')).toHaveText('if ($Name)');
  await page.locator('#back-button').click();
  await expect(page.locator('#layer-title')).toHaveText('Get-Widget');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('#layer-title')).toHaveText('Sample.psm1');
  await expect(page.locator('.mini-node[data-node-id="file:Sample.psm1"]')).toHaveAttribute('data-complete', 'false');
  await page.screenshot({ path: path.join(project, 'out', 'fixture', 'layers.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('active file trees center at either end, on helper jumps, zoom and resize', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.evaluate(() => {
    const strip = document.getElementById('mini-map');
    const scrollTo = strip.scrollTo.bind(strip);
    window.mapScrolls = [];
    strip.scrollTo = options => {
      window.mapScrolls.push({ behavior: options.behavior, from: strip.scrollLeft, to: options.left });
      scrollTo(options);
    };
  });
  const expectCentered = async () => {
    await expect.poll(() => page.evaluate(() => {
      const strip = document.getElementById('mini-map');
      const tree = strip.querySelector('.active-tree');
      if (!tree) return Infinity;
      const viewport = strip.getBoundingClientRect(), bounds = tree.getBoundingClientRect();
      return Math.abs(bounds.left + bounds.width / 2 - (viewport.left + strip.clientLeft + strip.clientWidth / 2));
    })).toBeLessThan(2);
  };
  await layer(page, 'Bootstrap.ps1').click();
  await expectCentered();
  const firstPosition = await page.locator('#mini-map').evaluate(strip => strip.scrollLeft);
  await page.locator('#home-button').click();
  await layer(page, 'Sample.psm1').click();
  await layer(page, 'Get-Widget').click();
  await layer(page, 'if ($Name)').click();
  await page.locator(`[data-call-target="${functionId('Invoke-RemoteHelper')}"]`).click();
  await expectCentered();
  expect(await page.locator('#mini-map').evaluate(strip => strip.scrollLeft)).toBeGreaterThan(firstPosition + 50);
  expect(await page.evaluate(() => window.mapScrolls.some(call => call.behavior === 'smooth' && Math.abs(call.to - call.from) > 50))).toBe(true);
  await page.locator('#zoom-in').click();
  await expectCentered();
  await page.locator('#back-button').click();
  await expectCentered();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectCentered();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.mini-tree[data-file="Bootstrap.ps1"] .mini-file-label').click();
  await expectCentered();
  expect(await page.evaluate(() => window.mapScrolls.at(-1).behavior)).toBe('instant');
});

test('global search, conditional inspector, root paths, persistence and source location', async ({ page }) => {
  const errors = [], externalRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.locator('#message-search').fill('Cannot read widget.');
  await expect(page.locator('.message-card')).toHaveCount(1);
  await page.locator('.message-card').click();
  await expect(page.locator('#details')).toBeVisible();
  await expect(page.locator('#app-layout')).toHaveClass(/has-inspector/);
  await expect(page.locator('#details')).toContainText('catch [System.IO.IOException]');
  await expect(page.locator('#details')).toContainText('Get-Widget');
  await expect(page.locator('#details')).toContainText('Set-Widget');
  await expect(page.locator('.code-line.current')).toContainText('Cannot read widget.');
  await page.getByRole('button', { name: '⚑ Flag', exact: true }).click();
  await page.getByRole('textbox', { name: 'Review comment' }).fill('Make this actionable.');
  const message = fixtureMap().messages.find(m => m.text === 'Cannot read widget.');
  await expect(page.locator(`.mini-node[data-node-id="${message.id}"]`)).toHaveAttribute('data-state', 'flagged');
  await page.reload();
  await page.locator('#message-search').fill('Cannot read widget.');
  await expect(page.locator('.message-card')).toHaveCount(1);
  await page.locator('.message-card').click();
  await expect(page.getByRole('textbox', { name: 'Review comment' })).toHaveValue('Make this actionable.');
  await expect(page.locator('[data-status="flagged"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Open code location' }).click();
  await expect(page.locator('#layer-title')).toHaveText('if (-not $Force)');
  await expect(page.locator('.message-card.selected')).toBeVisible();
  await page.locator('#back-button').click();
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#app-layout')).not.toHaveClass(/has-inspector/);
  await expect(page.locator('#layer-title')).toHaveText('Messages');
  await page.locator('.message-card').click();
  await page.locator('.route button').filter({ hasText: 'Get-Widget' }).click();
  await expect(page.locator('#layer-title')).toHaveText('Get-Widget');
  await expect(page.locator('#details')).toBeHidden();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#zoom-value')).toHaveText('110%');
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test('visited outlines persist before subtree completion; review colors aggregate and survive reload', async ({ page }) => {
  const map = fixtureMap();
  const f = { ...map.functions.find(f => f.name === 'Get-Widget'), id: 'only', file: 'Only.psm1', name: 'Get-Only', calls: [], messageIds: ['one', 'two'], rootIds: ['only'] };
  const template = map.messages[0];
  const messages = ['one', 'two'].map((id, i) => ({
    ...template, id, functionId: 'only', rootIds: ['only'], file: 'Only.psm1',
    text: `${id} message`, branches: [{ label: i ? 'else' : 'if ($Name)', line: i + 2, offset: i + 20 }]
  }));
  const small = { ...map, name: 'Completion', functions: [f], messages, callSites: [], diagnostics: [], dynamicCalls: [] };
  await page.locator('#data-input').setInputFiles({ name: 'small.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(small)) });
  await layer(page, 'Only.psm1').click();
  await layer(page, 'Get-Only').click();
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-complete', 'false');
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-state', 'viewed');
  await page.locator('#back-button').click();
  await expect(page.locator('.mini-node[data-node-id="only"]')).not.toHaveClass(/current/);
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-state', 'viewed');
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-complete', 'false');
  await page.locator('#data-input').setInputFiles({ name: 'small.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(small)) });
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-state', 'viewed');
  await expect(page.locator('.mini-node[data-node-id="only"]')).toHaveAttribute('data-complete', 'false');
  await layer(page, 'Only.psm1').click();
  await layer(page, 'Get-Only').click();
  await layer(page, 'if ($Name)').click();
  await page.locator('.message-card').click();
  await page.getByRole('button', { name: '✓ Approve', exact: true }).click();
  await page.locator('#back-button').click();
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-state', 'viewed');
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-complete', 'false');
  await layer(page, 'else').click();
  await page.locator('.message-card').click();
  await page.getByRole('button', { name: '✓ Approve', exact: true }).click();
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-complete', 'true');
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-state', 'approved');
  await page.getByRole('button', { name: '○ Unreviewed', exact: true }).click();
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-state', 'viewed');
  await page.getByRole('button', { name: '⚑ Flag', exact: true }).click();
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-state', 'flagged');
  await page.getByRole('button', { name: 'Close message details' }).click();
  await page.locator('.mini-node[data-node-id="one"]').click();
  await expect(page.locator('.message-preview')).toHaveText('one message');
  await expect(page.locator('#layer-title')).toHaveText('if ($Name)');
  await page.locator('#data-input').setInputFiles({ name: 'small.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(small)) });
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-state', 'flagged');
  await expect(page.locator('.mini-node[data-node-id="file:Only.psm1"]')).toHaveAttribute('data-complete', 'true');
});

test('unreachable filter, CSV formula safety, review/visit backups and malformed map feedback', async ({ page }) => {
  await page.locator('#all-messages').click();
  await page.getByRole('button', { name: 'Review & quality' }).click();
  await page.locator('#quality-filter').selectOption('unreachable');
  await expect(page.locator('#journey')).toContainText('An orphaned warning.');
  await page.locator('.message-card').filter({ hasText: 'An orphaned warning.' }).click();
  await page.getByRole('textbox', { name: 'Review comment' }).fill('=SUM(1,2)');
  await page.locator('#export-button').click();
  const csvDownload = page.waitForEvent('download');
  await page.locator('#download-csv').click();
  const csv = fs.readFileSync(await (await csvDownload).path(), 'utf8');
  expect(csv).toContain(`"'=SUM(1,2)"`);
  expect(csv).toContain('entryPoints');
  const backupDownload = page.waitForEvent('download');
  await page.locator('#download-review').click();
  const backup = fs.readFileSync(await (await backupDownload).path());
  expect(JSON.parse(backup).visited.length).toBeGreaterThan(1);
  await page.locator('#review-input').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: backup });
  await expect(page.locator('#toast')).toContainText('Imported 1 matching annotations.');
  await page.locator('#close-export').click();
  await page.locator('#data-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":9}') });
  await expect(page.locator('#toast')).toContainText('Could not open map');
  await expect(page.locator('.message-preview')).toContainText('An orphaned warning.');
});

test('large synthetic forest, hidden inspector, search, source and narrow-screen layout', async ({ page }) => {
  const seed = fixtureMap();
  const rootIds = Array.from({ length: 400 }, (_, i) => `sample-${i}`);
  const scopes = rootIds.map((id, i) => ({
    id, name: `Get-SampleWidget${i}`, file: `Widget.Module${i % 20}.psm1`, line: 1,
    scopeType: 'function', parentId: '', exportReason: 'sample public function',
    exported: true, calls: ['sample-helper'], messageIds: Array.from({ length: 5 }, (_, j) => `${id}-message-${j}`), rootIds: [id]
  }));
  scopes.push({
    id: 'sample-helper', name: 'Invoke-SampleHelper', file: 'SharedUtilities.psm1', line: 1,
    scopeType: 'function', parentId: '', exportReason: '', exported: false,
    calls: [], messageIds: ['sample-helper-message'], rootIds
  });
  const sampleMessages = scopes.flatMap((f, i) => f.messageIds.map((id, j) => ({
    ...seed.messages[0], id, functionId: f.id, file: f.file, rootIds: f.rootIds,
    kind: j ? 'verbose' : 'warning', text: j ? `Sample widget ${i} progress ${j}.` : `Widget ${i} is not available.`,
    line: j + 2, column: 5, resolution: 'literal', lint: [], duplicateGroup: null,
    expression: `Write-Warning 'Widget ${i} is not available.'`,
    source: `function ${f.name} {\n    Write-Warning 'Widget ${i} is not available.'\n}`,
    sourceStartLine: 1,
    branches: j ? [{ label: 'if ($Name)', line: 2, column: 1, offset: 20 }] : []
  })));
  const largeMap = {
    ...seed, name: 'SampleWidgetModule', sourcePath: 'C:\\samples\\WidgetModule',
    functions: scopes, messages: sampleMessages, diagnostics: [], dynamicCalls: [],
    callSites: scopes.filter(f => f.calls.length).map(f => ({
      functionId: f.id, targetId: 'sample-helper', file: f.file, line: 8, column: 5,
      branches: [], expression: 'Invoke-SampleHelper'
    })),
    stats: { files: 21, functions: scopes.length, roots: rootIds.length, messages: sampleMessages.length, duplicateGroups: 0, dynamicCalls: 0, parseErrors: 0 }
  };
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('#data-input').setInputFiles({ name: 'sample-map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(largeMap)) });
  await expect(page.locator('#workspace-name')).toHaveText('SampleWidgetModule');
  await expect(page.locator('#layer-title')).toHaveText('Choose a file');
  await expect(page.locator('#details')).toBeHidden();
  await page.screenshot({ path: path.join(project, 'out', 'fixture', 'large-map-home.png'), fullPage: true, animations: 'disabled' });
  const counts = await page.locator('.mini-node[data-node-type="function"]').evaluateAll(nodes => ({
    total: nodes.length, unique: new Set(nodes.map(n => n.dataset.nodeId)).size
  }));
  expect(counts.total).toBeGreaterThan(300);
  expect(counts.total).toBe(counts.unique);
  await page.locator('#message-search').fill('Widget 42 is not available.');
  await expect(page.locator('#result-count')).toContainText('Widget 42 is not available.');
  await page.locator('.message-card').first().click();
  await expect(page.locator('.message-preview')).toContainText('Widget 42 is not available.');
  await expect(page.locator('.code-block')).toBeVisible();
  await page.screenshot({ path: path.join(project, 'out', 'fixture', 'large-map-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#details')).toBeVisible();
  await page.getByRole('button', { name: 'Close message details' }).click();
  await page.locator('#home-button').click();
  await page.screenshot({ path: path.join(project, 'out', 'fixture', 'large-map-mobile.png'), fullPage: true, animations: 'disabled' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
