# PSTextViewer

A local-first PowerShell message atlas. Follow an entry point through helpers and
branch conditions, or search for a message and trace it back to its roots.

## Run

Requires PowerShell 7.2+ and a modern browser. No npm install, web server, module
import, cloud service, or external browser assets are needed to use the viewer.

```powershell
Set-Location C:\tools\PSTextViewer
.\Export-PSTextMap.ps1 -Path C:\src\MyModule -OutputPath .\out\my-module -Open
```

`Path` accepts a folder or an individual `.ps1` / `.psm1` file. Scan a folder to
include its manifests, helper files, and localization data. Build and dependency
directories (`bin`, `obj`, `out`, `publish`, `node_modules`, `.git`) and reparse
points are skipped.

For custom logging wrappers, opt in explicitly:

```powershell
.\Export-PSTextMap.ps1 -Path C:\src\MyModule `
    -TraceCommand Trace-MyModule,Write-MyLog -OutputPath .\out\my-module -Open
```

Two files are generated:

- `PSTextViewer.html`: self-contained viewer with embedded map and source snippets.
- `pstextmap.json`: reusable data; load another map using **Open map**.

To try the viewer with the included synthetic sample module:

```powershell
.\Export-PSTextMap.ps1 -Path .\tests\fixtures `
    -TraceCommand Trace-Widget -OutputPath .\out\demo -Open
```

## Explore and review

- Start with a file, choose an exported entry point or **Module-level text**, then
  drill into one code path at a time. Files without entry points or module-level
  messages are hidden from the initial chooser; **Include helper-only files**
  exposes them. Within a file, **Include internal functions** exposes helpers.
- Function and branch layers show messages, branches, and helper calls in source
  order. Click a branch to enter it. Click a helper call to jump to that function's
  canonical location, including across files. **Back**, **Alt+Left**, or breadcrumbs
  take you out again. Back returns to the caller after a cross-file jump.
- The inspector is hidden until a message is selected. Leaving a layer closes it.
  **Open code location** jumps from a search result to the owning code path.
- `/` focuses global search. Search covers text, expressions, branch conditions,
  function names, entry points, and file names. It is literal, not regex.
  **All messages** includes functions with no known exported root.
- Filter by stream, review state, lint, similar wording, dynamic text, or unknown
  reachability. Internal functions and class methods remain available through
  file-level navigation, global search, and the structure map.
- Click a message for its template, editable sample substitutions, source snippet,
  local branch conditions, and one shortest path from each known entry point.
  Click a root path to navigate to that entry point.
- Approve or flag messages and add comments. Reviews save to browser local
  storage when available; the UI warns if it cannot save. Use JSON backups for
  portable persistence, especially when moving the HTML file or changing browser.
- **Export review** downloads all messages with annotations as CSV or backs up
  annotations as JSON. CSV text is protected against leading spreadsheet formulas.
  Import merges matching message IDs; imported values replace existing annotations
  for those IDs.
- Zoom the miniature structure map with its buttons or Ctrl+wheel. Toggle the
  light theme in the header. Layer transitions respect reduced-motion preferences.

## Structure map and progress

The horizontal strip contains one canonical tree per file:
**file -> function -> code path -> message**. Function calls are jump links, not
tree edges. A shared helper appears once, and recursive calls cannot make these
ownership trees circular. Hover a tiny rectangle for its name and progress;
click it to navigate. Keyboard focus supports arrows between parents, children,
and siblings, with Enter to open. The active file tree smoothly scrolls to the
center of the strip, including after zooming or resizing. Reduced-motion mode
centers it immediately instead.

- Solid white: current file, function, code path, or selected message.
- White outline: this node has been visited, even if its descendants have not.
- Green: all owned messages approved and the owned subtree completely visited.
- Red: at least one owned message flagged.
- Dim outline: this node has not been visited.

Viewing a message marks its ancestor location as visited but does not mark its
siblings. Filters never hide unfinished work from completion calculations.
Progress is based on canonical **ownership**, not transitive call reachability:
linked helper functions belong to their own file's tree, so approving a caller
does not approve its helpers. File completion includes its internal functions,
even when those functions are hidden from the entry-point chooser.

Visits save alongside reviews in browser storage and are included in JSON review
backups. Existing review-only backups remain compatible. The current white fill
temporarily takes precedence over review color; its border retains the review
color. Moving away reveals its normal review/completion color.

Review IDs use relative file, function, kind, and source expression, so unrelated
line changes do not discard annotations. Changing a message's source expression
intentionally creates a new review identity. Browser storage is namespaced by
module name and relative file set; when the file set changes, import your JSON
backup to carry matching annotations forward.

## What is extracted

Comment-based synopsis, description, parameter documentation, examples and notes;
parameter `HelpMessage`; standard output/error/warning/verbose/debug/information
commands; host output and input prompts; throws; recognizable exception
constructors; `$PSCmdlet` message methods; `ShouldProcess` and `ShouldContinue`;
and explicitly configured trace commands.

The parser preserves expandable templates and `-f` templates. It can show possible
preceding variable assignments and unambiguous `$LocalizedData.Key`-style strings
from literal `.psd1` tables or `ConvertFrom-StringData` resources.

## Boundaries

This is a **static review aid**, not a PowerShell runtime or proof of coverage.

- No scanned module code is executed. Imports, remoting, dynamic invocation, class
  method dispatch, splatting and runtime aliases can hide call edges.
- Exports are combined across scanned files. Manifest module loading, export
  restrictions, and conditional export statements are not simulated. With no
  explicit exports, uncalled functions are labeled inferred entry points.
  Module/script initialization is a separately labeled entry point.
- Reachability means a possible static path. Conditions shown on a message are
  local to its function; call cards sit within their own enclosing branch layers.
  Call-site conditions are not propagated into the called function's tree.
  The inspector shows one shortest path per root, not every combinatorial path.
- Variable resolution is a possible assignment, not control-flow or data-flow
  analysis. Localized keys with differing discovered values remain ambiguous.
- Branch summaries and literal placeholders are source representations. The
  sample preview does not run PowerShell or implement format specifiers.
- Wording lint is heuristic. Similar-message groups normalize placeholders, case,
  and punctuation, not semantics. Inline text is a localization suggestion, not
  automatically a defect.
- The structure map is an acyclic ownership forest, not a runtime call graph.
  Call recursion remains navigable through jump links and the Back stack.
  Large message lists and code-path layers use **Show more** render budgets.
- Maps generated before call-site extraction still open. Their call portals are
  labeled approximate because branch location and call order are unavailable;
  regenerate the map for accurate placement.

**Treat generated HTML, JSON, CSV, and screenshots as source-code artifacts.**
They contain source snippets and potentially sensitive message templates. Nothing
is uploaded by the viewer.

## Develop

The UI is plain JavaScript/CSS; there is no frontend build step. `web\model.js`
contains the independently tested ownership/progress/layout model.

```powershell
npm install
npm run check
npm test
npm run test:browser
```

`npm test` regenerates `out\fixture` from focused parser fixtures. Browser tests
use an installed Microsoft Edge through Playwright; no browser download is needed
on the development machine. Change `channel` in `playwright.config.cjs` for a
different installed browser. Large-map browser coverage uses generated sample
functions and messages, with no external module or repository required.

After editing `web\` or the extractor, rerun `Export-PSTextMap.ps1` to regenerate
the HTML you open. Existing generated reports are snapshots.
