using namespace System.Management.Automation.Language
#requires -Version 7.2
<#
.SYNOPSIS
Builds an offline, searchable map of PowerShell messages without running the module.
.EXAMPLE
.\Export-PSTextMap.ps1 -Path C:\src\MyModule -OutputPath .\out -Open
.EXAMPLE
.\Export-PSTextMap.ps1 -Path C:\src\MyModule -TraceCommand Trace-MyModule,Write-CustomLog
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string] $Path,
    [string] $OutputPath = (Join-Path $PSScriptRoot 'out'),
    [string[]] $TraceCommand = @(),
    [string[]] $ExcludeDirectory = @('.git', 'node_modules', 'bin', 'obj', 'out', 'publish'),
    [switch] $Open
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$inputItem = Get-Item -LiteralPath $Path
if (-not $inputItem.PSIsContainer -and $inputItem.Extension -notin @('.ps1', '.psm1')) {
    throw 'Path must be a directory or a .ps1 / .psm1 file. Scan a directory to include manifests and localization resources.'
}
$basePath = if ($inputItem.PSIsContainer) { $inputItem.FullName } else { $inputItem.DirectoryName }
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$functions = [Collections.Generic.List[object]]::new()
$messages = [Collections.Generic.List[object]]::new()
$diagnostics = [Collections.Generic.List[object]]::new()
$dynamicCalls = [Collections.Generic.List[object]]::new()
$callSites = [Collections.Generic.List[object]]::new()
$units = [Collections.Generic.List[object]]::new()
$byId = @{}
$byName = @{}
$scopeMap = [Collections.Generic.Dictionary[Ast, object]]::new()
$localization = @{}
$explicitExports = [Collections.Generic.List[object]]::new()
$hasExplicitExports = $false
$streamMap = @{
    'write-error' = 'error'; 'write-warning' = 'warning'; 'write-verbose' = 'verbose'
    'write-debug' = 'debug'; 'write-information' = 'information'; 'write-host' = 'output'
    'write-output' = 'output'; 'read-host' = 'prompt'
}
foreach ($name in $TraceCommand) { $streamMap[$name.ToLowerInvariant()] = 'trace' }
$aliases = @{ echo = 'write-output' }

function Get-Owner([Ast] $Node, $Unit) {
    $current = $Node.Parent
    while ($null -ne $current) {
        if ($scopeMap.ContainsKey($current)) { return $scopeMap[$current] }
        $current = $current.Parent
    }
    return $Unit.script
}

function Get-Expression([Ast] $Node) {
    while ($null -ne $Node) {
        if ($Node -is [PipelineAst] -and $Node.PipelineElements.Count -eq 1 -and $Node.PipelineElements[0] -is [CommandExpressionAst]) {
            $Node = $Node.PipelineElements[0].Expression
        } elseif ($Node -is [CommandExpressionAst]) { $Node = $Node.Expression
        } elseif ($Node -is [ParenExpressionAst]) { $Node = $Node.Pipeline
        } elseif ($Node -is [StatementBlockAst] -and $Node.Statements.Count -eq 1) { $Node = $Node.Statements[0]
        } else { break }
    }
    return $Node
}

function Get-Literals([Ast] $Node) {
    if ($null -eq $Node) { return }
    $Node = Get-Expression $Node
    if ($Node -is [StringConstantExpressionAst]) { return $Node.Value }
    if ($Node -is [ArrayLiteralAst]) {
        foreach ($element in $Node.Elements) { Get-Literals $element }
    } elseif ($Node -is [ArrayExpressionAst]) {
        foreach ($statement in $Node.SubExpression.Statements) { Get-Literals $statement }
    } elseif ($Node -is [PipelineAst]) {
        foreach ($element in $Node.PipelineElements) { Get-Literals $element }
    }
}

function Get-CommandArgument([CommandAst] $Command, [string[]] $Names, [int] $Position = 0) {
    $elements = $Command.CommandElements
    $positional = [Collections.Generic.List[object]]::new()
    for ($i = 1; $i -lt $elements.Count; $i++) {
        $element = $elements[$i]
        if ($element -is [CommandParameterAst]) {
            if ($element.ParameterName -in $Names) {
                if ($null -ne $element.Argument) { return $element.Argument }
                if ($i + 1 -lt $elements.Count -and $elements[$i + 1] -isnot [CommandParameterAst]) { return $elements[$i + 1] }
                return $null
            }
            # Common switches have no argument. Other named arguments are not positional text.
            if ($element.ParameterName -notin @('Verbose', 'Debug', 'NoNewline', 'AsSecureString', 'AsMask', 'InformationVariable') -and
                $null -eq $element.Argument -and $i + 1 -lt $elements.Count -and $elements[$i + 1] -isnot [CommandParameterAst]) { $i++ }
        } else { $positional.Add($element) }
    }
    if ($positional.Count -gt $Position) { return $positional[$Position] }
    return $null
}

function Get-Branches([Ast] $Node, $Owner) {
    $result = [Collections.Generic.List[object]]::new()
    $child = $Node
    $parent = $Node.Parent
    while ($null -ne $parent) {
        if ($parent -is [FunctionDefinitionAst] -or $parent -is [FunctionMemberAst]) { break }
        $label = $null
        if ($parent -is [IfStatementAst]) {
            $prior = [Collections.Generic.List[string]]::new()
            foreach ($clause in $parent.Clauses) {
                if ($child -eq $clause.Item2) {
                    $prefix = if ($prior.Count) { 'elseif' } else { 'if' }
                    $label = "$prefix ($($clause.Item1.Extent.Text))"
                    if ($prior.Count) { $label += ' [previous conditions false]' }
                    break
                }
                $prior.Add($clause.Item1.Extent.Text)
            }
            if ($child -eq $parent.ElseClause) { $label = "else (not: $($prior -join '; '))" }
        } elseif ($parent -is [CatchClauseAst]) {
            $types = @($parent.CatchTypes | ForEach-Object { $_.Extent.Text })
            $label = if ($types.Count) { "catch $($types -join ', ')" } else { 'catch (any exception)' }
        } elseif ($parent -is [SwitchStatementAst]) {
            foreach ($clause in $parent.Clauses) {
                if ($child -eq $clause.Item2) { $label = "switch ($($parent.Condition.Extent.Text)): $($clause.Item1.Extent.Text)"; break }
            }
            if ($child -eq $parent.Default) { $label = "switch ($($parent.Condition.Extent.Text)): default" }
        } elseif ($parent -is [LoopStatementAst] -and $child -eq $parent.Body) {
            $label = ($parent.Extent.Text -split '\r?\n')[0].Trim().TrimEnd('{').Trim()
        } elseif ($parent -is [TryStatementAst]) {
            if ($child -eq $parent.Body) { $label = 'try' }
            elseif ($child -eq $parent.Finally) { $label = 'finally' }
        }
        if ($label) {
            $result.Insert(0, [ordered]@{
                label = $label; line = $child.Extent.StartLineNumber
                column = $child.Extent.StartColumnNumber; offset = $child.Extent.StartOffset
            })
        }
        $child = $parent
        $parent = $parent.Parent
    }
    return $result.ToArray()
}

function Resolve-Text([Ast] $Node, $Unit, $Owner, [int] $Depth = 0) {
    if ($null -eq $Node) { return @{ text = '[pipeline input or unspecified message]'; resolution = 'dynamic' } }
    $Node = Get-Expression $Node
    if ($Depth -gt 6) { return @{ text = $Node.Extent.Text; resolution = 'dynamic' } }
    if ($Node -is [StringConstantExpressionAst] -or $Node -is [ExpandableStringExpressionAst]) {
        return @{ text = $Node.Value; resolution = $(if ($Node -is [ExpandableStringExpressionAst]) { 'template' } else { 'literal' }) }
    }
    if ($Node -is [BinaryExpressionAst] -and $Node.Operator -eq 'Format') {
        $left = Resolve-Text $Node.Left $Unit $Owner ($Depth + 1)
        return @{ text = $left.text; resolution = 'format template' }
    }
    if ($Node -is [BinaryExpressionAst] -and $Node.Operator -eq 'Plus') {
        $left = Resolve-Text $Node.Left $Unit $Owner ($Depth + 1)
        $right = Resolve-Text $Node.Right $Unit $Owner ($Depth + 1)
        return @{ text = "$($left.text)$($right.text)"; resolution = 'concatenated template' }
    }
    if ($Node -is [VariableExpressionAst]) {
        $varName = $Node.VariablePath.UserPath
        $assignments = @($Unit.assignments | Where-Object {
            $_.Left -is [VariableExpressionAst] -and $_.Left.VariablePath.UserPath -eq $varName -and
            $_.Extent.StartOffset -lt $Node.Extent.StartOffset -and (Get-Owner $_ $Unit).id -eq $Owner.id
        } | Sort-Object { $_.Extent.StartOffset } -Descending)
        if ($assignments.Count) {
            $value = Resolve-Text $assignments[0].Right $Unit $Owner ($Depth + 1)
            return @{ text = $value.text; resolution = 'possible assignment (flow not proven)' }
        }
    }
    if ($Node -is [MemberExpressionAst] -and $Node.Expression -is [VariableExpressionAst] -and
        $Node.Expression.VariablePath.UserPath -match '(?i)(localized|strings|resources|messages)') {
        $key = $Node.Member.Extent.Text.Trim("'", '"').ToLowerInvariant()
        if ($localization.ContainsKey($key)) {
            $values = @($localization[$key] | Select-Object -Unique)
            if ($values.Count -eq 1) { return @{ text = $values[0]; resolution = "localized: $key" } }
            return @{ text = $Node.Extent.Text; resolution = "ambiguous localization: $key ($($values.Count) values)" }
        }
    }
    if ($Node -is [InvokeMemberExpressionAst] -and $Node.Member.Extent.Text -eq 'new' -and $Node.Arguments.Count) {
        return Resolve-Text $Node.Arguments[0] $Unit $Owner ($Depth + 1)
    }
    return @{ text = $Node.Extent.Text; resolution = 'dynamic' }
}

function Add-Message($Unit, $Owner, [Ast] $Node, [string] $Kind, [Ast] $TextNode, [string] $HelpText = '', [int] $HelpLine = 0) {
    $resolved = if ($HelpText) { @{ text = $HelpText.Trim(); resolution = 'help' }
        } elseif ($Kind -eq 'throw' -and $null -eq $TextNode) { @{ text = '[rethrow current exception]'; resolution = 'dynamic' }
        } else { Resolve-Text $TextNode $Unit $Owner }
    $line = if ($HelpLine) { $HelpLine } else { $Node.Extent.StartLineNumber }
    $start = [Math]::Max(1, $line - 3)
    $end = [Math]::Min($Unit.lines.Count, [Math]::Max($line + 3, [Math]::Min($Node.Extent.EndLineNumber, $line + 16)))
    $expression = if ($HelpText) { ".$Kind`n$HelpText" } else { $Node.Extent.Text }
    $hashInput = "$($Unit.file)|$($Owner.name)|$Kind|$expression"
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($hashInput))).Substring(0, 20).ToLowerInvariant()
    $id = "m-$hash"
    # Distinguish repeated identical statements while keeping IDs stable across unrelated line shifts.
    $occurrence = 1
    while ($script:messageIds.Contains($id)) { $occurrence++; $id = "m-$hash-$occurrence" }
    [void] $script:messageIds.Add($id)
    $lint = [Collections.Generic.List[string]]::new()
    if ($Kind -eq 'error' -and $resolved.text -match '^\s*error\s*:') { $lint.Add('Redundant "Error:" prefix') }
    if ($resolved.text -match '[!?.,]{2,}$' -and $resolved.text -notmatch '\.\.\.$') { $lint.Add('Repeated terminal punctuation') }
    if ($resolved.text -match '(?i)\b(password|secret|token)\s*[:=]\s*\$') { $lint.Add('Check for sensitive data in output') }
    if ($resolved.resolution -in @('literal', 'template', 'format template', 'concatenated template') -and $Kind -notin @('synopsis', 'description', 'parameter', 'example', 'notes')) {
        $lint.Add('Inline text: consider localization')
    }
    $expr = if ($null -ne $TextNode) { Get-Expression $TextNode } else { $null }
    if ($expr -is [BinaryExpressionAst] -and $expr.Operator -eq 'Format') {
        $argsNode = Get-Expression $expr.Right
        $argCount = if ($argsNode -is [ArrayLiteralAst]) { $argsNode.Elements.Count } else { 1 }
        $indices = @([regex]::Matches($resolved.text, '(?<!\{)(?:\{\{)*\{(\d+)(?:[^{}]*)\}(?!\})') | ForEach-Object { [int] $_.Groups[1].Value })
        if ($indices.Count -and ($indices | Measure-Object -Maximum).Maximum -ge $argCount) { $lint.Add('Format placeholder has no matching argument (static estimate)') }
    }
    $message = [ordered]@{
        id = $id; functionId = $Owner.id; kind = $Kind; text = $resolved.text; resolution = $resolved.resolution
        file = $Unit.file; line = $line; column = $Node.Extent.StartColumnNumber; expression = $expression
        branches = @(Get-Branches $Node $Owner); source = ($Unit.lines[($start - 1)..($end - 1)] -join "`n")
        sourceStartLine = $start; rootIds = @(); lint = @($lint.ToArray()); duplicateGroup = $null
    }
    $messages.Add($message)
    $Owner.messageIds.Add($id)
}

function Add-Scope($Unit, [Ast] $Node, [string] $Name, [string] $Type, [string] $ParentId = '') {
    $id = "f-$($functions.Count)"
    $scope = [ordered]@{
        id = $id; name = $Name; file = $Unit.file; line = $Node.Extent.StartLineNumber
        scopeType = $Type; parentId = $ParentId; exported = $false; exportReason = ''
        calls = [Collections.Generic.List[string]]::new(); messageIds = [Collections.Generic.List[string]]::new(); rootIds = @()
    }
    $functions.Add($scope)
    $byId[$id] = $scope
    $scopeMap[$Node] = $scope
    if (-not $byName.ContainsKey($Name)) { $byName[$Name] = [Collections.Generic.List[object]]::new() }
    $byName[$Name].Add($scope)
    return $scope
}

$files = if ($inputItem.PSIsContainer) {
    # Walk explicitly so excluded build/dependency folders are never descended into.
    $queue = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
    $queue.Enqueue($inputItem)
    while ($queue.Count) {
        $directory = $queue.Dequeue()
        foreach ($item in Get-ChildItem -LiteralPath $directory.FullName) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($item.PSIsContainer) {
                if ($item.Name -notin $ExcludeDirectory -and $item.FullName -ne $outputFullPath) { $queue.Enqueue($item) }
            } elseif ($item.Extension -in @('.ps1', '.psm1', '.psd1')) { $item }
        }
    }
} else { $inputItem }
$files = @($files | Sort-Object FullName)
if (-not $files.Count) { throw "No PowerShell files found under $basePath." }
$messageIds = [Collections.Generic.HashSet[string]]::new()

foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    $ast = [Parser]::ParseFile($file.FullName, [ref] $tokens, [ref] $parseErrors)
    $relative = [IO.Path]::GetRelativePath($basePath, $file.FullName)
    foreach ($errorItem in $parseErrors) {
        $diagnostics.Add(@{ severity = 'warning'; file = $relative; line = $errorItem.Extent.StartLineNumber; message = $errorItem.Message })
    }
    if ($file.Extension -eq '.psd1') {
        $tables = @($ast.FindAll({ param($n) $n -is [HashtableAst] }, $true))
        foreach ($table in $tables) {
            foreach ($pair in $table.KeyValuePairs) {
                $key = $pair.Item1.Extent.Text.Trim("'", '"')
                if ($key -eq 'FunctionsToExport') {
                    $hasExplicitExports = $true
                    foreach ($pattern in @(Get-Literals $pair.Item2)) { $explicitExports.Add(@{ file = '*'; pattern = $pattern; reason = "manifest: $relative" }) }
                }
                $value = Get-Expression $pair.Item2
                if ($value -is [StringConstantExpressionAst]) {
                    if (-not $localization.ContainsKey($key)) { $localization[$key] = [Collections.Generic.List[string]]::new() }
                    $localization[$key].Add($value.Value)
                }
            }
        }
        # ConvertFrom-StringData localization files are parsed as data, never invoked.
        foreach ($command in @($ast.FindAll({ param($n) $n -is [CommandAst] -and $n.GetCommandName() -eq 'ConvertFrom-StringData' }, $true))) {
            $literal = Get-CommandArgument $command @('StringData')
            if ($literal -is [StringConstantExpressionAst]) {
                try {
                    $data = ConvertFrom-StringData -StringData $literal.Value
                    foreach ($key in $data.Keys) {
                        if (-not $localization.ContainsKey($key)) { $localization[$key] = [Collections.Generic.List[string]]::new() }
                        $localization[$key].Add($data[$key])
                    }
                } catch {
                    $diagnostics.Add(@{ severity = 'warning'; file = $relative; line = $literal.Extent.StartLineNumber; message = 'Could not parse ConvertFrom-StringData localization data.' })
                }
            }
        }
        continue
    }
    $unit = @{
        ast = $ast; file = $relative; lines = [IO.File]::ReadAllLines($file.FullName)
        assignments = @($ast.FindAll({ param($n) $n -is [AssignmentStatementAst] }, $true))
        commands = @($ast.FindAll({ param($n) $n -is [CommandAst] }, $true))
        comments = @($tokens | Where-Object Kind -EQ 'Comment')
        script = $null
    }
    $unit.script = Add-Scope $unit $ast "<script: $relative>" 'script'
    foreach ($definition in @($ast.FindAll({ param($n) $n -is [FunctionDefinitionAst] -or $n -is [FunctionMemberAst] }, $true))) {
        $parent = Get-Owner $definition $unit
        $name = $definition.Name -replace '^(global|script|local|private):', ''
        $type = if ($definition -is [FunctionMemberAst]) { 'method' } else { 'function' }
        $null = Add-Scope $unit $definition $name $type $parent.id
    }
    $units.Add($unit)
}

foreach ($unit in $units) {
    foreach ($command in $unit.commands) {
        $name = $command.GetCommandName()
        if ($name -eq 'Export-ModuleMember') {
            $hasExplicitExports = $true
            foreach ($pattern in @(Get-Literals (Get-CommandArgument $command @('Function')))) {
                $explicitExports.Add(@{ file = $unit.file; pattern = $pattern; reason = 'Export-ModuleMember' })
            }
        } elseif ($name -in @('Set-Alias', 'New-Alias')) {
            $aliasName = @(Get-Literals (Get-CommandArgument $command @('Name') 0))
            $aliasValue = @(Get-Literals (Get-CommandArgument $command @('Value') 1))
            if ($aliasName.Count -eq 1 -and $aliasValue.Count -eq 1) { $aliases[$aliasName[0]] = $aliasValue[0] }
        }
    }
}

foreach ($unit in $units) {
    foreach ($command in $unit.commands) {
        $owner = Get-Owner $command $unit
        $name = $command.GetCommandName()
        if (-not $name) {
            $dynamicCalls.Add(@{ functionId = $owner.id; file = $unit.file; line = $command.Extent.StartLineNumber; expression = $command.Extent.Text })
            continue
        }
        $name = ($name -split '\\')[-1]
        if ($aliases.ContainsKey($name)) { $name = $aliases[$name] }
        $normalized = $name.ToLowerInvariant()
        if ($streamMap.ContainsKey($normalized)) {
            $argument = Get-CommandArgument $command @('Message', 'Object', 'InputObject', 'Prompt', 'ErrorRecord')
            Add-Message $unit $owner $command $streamMap[$normalized] $argument
        } elseif ($name -eq 'New-Object') {
            $typeName = Get-CommandArgument $command @('TypeName')
            if ($null -ne $typeName -and $typeName.Extent.Text -match '(?i)Exception') {
                $argument = Get-CommandArgument $command @('ArgumentList') 1
                Add-Message $unit $owner $command 'exception' $argument
            }
        }
        if ($byName.ContainsKey($name)) {
            $candidates = @($byName[$name])
            $sameFile = @($candidates | Where-Object file -EQ $unit.file)
            if ($sameFile.Count) { $candidates = $sameFile }
            $visible = @($candidates | Where-Object { $_.parentId -eq $owner.id -or $_.parentId -eq $owner.parentId -or $_.id -eq $owner.id })
            if ($visible.Count) { $candidates = $visible }
            if ($candidates.Count -gt 1) {
                $diagnostics.Add(@{ severity = 'info'; file = $unit.file; line = $command.Extent.StartLineNumber; message = "Ambiguous call to ${name}: all $($candidates.Count) candidates included." })
            }
            foreach ($target in $candidates) {
                if (-not $owner.calls.Contains($target.id)) { $owner.calls.Add($target.id) }
                $callSites.Add([ordered]@{
                    functionId = $owner.id; targetId = $target.id; file = $unit.file
                    line = $command.Extent.StartLineNumber; column = $command.Extent.StartColumnNumber
                    expression = $command.Extent.Text; branches = @(Get-Branches $command $owner)
                })
            }
        }
    }
    foreach ($node in @($unit.ast.FindAll({
        param($n) $n -is [ThrowStatementAst] -or $n -is [InvokeMemberExpressionAst] -or $n -is [AttributeAst]
    }, $true))) {
        $owner = Get-Owner $node $unit
        if ($node -is [ThrowStatementAst]) {
            Add-Message $unit $owner $node 'throw' $node.Pipeline
        } elseif ($node -is [InvokeMemberExpressionAst]) {
            $memberName = $node.Member.Extent.Text
            $kind = switch ($memberName) {
                'ThrowTerminatingError' { 'error' }
                'WriteError' { 'error' }
                'WriteWarning' { 'warning' }
                'WriteVerbose' { 'verbose' }
                'WriteDebug' { 'debug' }
                'WriteInformation' { 'information' }
                'ShouldProcess' { 'prompt' }
                'ShouldContinue' { 'prompt' }
                default { $null }
            }
            $insideThrow = $false
            $ancestor = $node.Parent
            while ($ancestor -and $ancestor -isnot [StatementBlockAst]) {
                if ($ancestor -is [ThrowStatementAst]) { $insideThrow = $true; break }
                $ancestor = $ancestor.Parent
            }
            if ($memberName -eq 'new' -and $node.Expression.Extent.Text -match '(?i)Exception\]$' -and -not $insideThrow) { $kind = 'exception' }
            if ($kind) {
                if ($node.Arguments.Count) {
                    foreach ($argument in $node.Arguments) {
                        # Exception constructors' non-string arguments are context, not separate messages.
                        Add-Message $unit $owner $node $kind $argument
                        if ($kind -eq 'exception' -or $memberName -notin @('ShouldProcess', 'ShouldContinue')) { break }
                    }
                } else { Add-Message $unit $owner $node $kind $null }
            }
        } elseif ($node.TypeName.Name -in @('Parameter', 'ParameterAttribute')) {
            foreach ($argument in $node.NamedArguments) {
                if ($argument.ArgumentName -eq 'HelpMessage') { Add-Message $unit $owner $node 'parameter' $argument.Argument }
            }
        }
    }
    foreach ($definition in @($unit.ast.FindAll({ param($n) $n -is [FunctionDefinitionAst] }, $true))) {
        $owner = $scopeMap[$definition]
        $help = $definition.GetHelpContent()
        if ($null -eq $help) { continue }
        $helpComments = @($unit.comments | Where-Object {
            $_.Text -match '(?im)^\s*(?:<#\s*)?\.SYNOPSIS\b' -and
            $_.Extent.StartOffset -lt $definition.Body.Extent.EndOffset
        } | Sort-Object { [Math]::Abs($_.Extent.StartOffset - $definition.Extent.StartOffset) })
        $helpComment = if ($helpComments.Count) { $helpComments[0] } else { $null }
        foreach ($property in @('Synopsis', 'Description', 'Notes')) {
            if ($help.$property) {
                $helpLine = $definition.Extent.StartLineNumber
                if ($helpComment) {
                    $match = [regex]::Match($helpComment.Text, "(?im)^\s*\.$property\b")
                    if ($match.Success) { $helpLine = $helpComment.Extent.StartLineNumber + ([regex]::Matches($helpComment.Text.Substring(0, $match.Index + $match.Length), "`n")).Count }
                }
                Add-Message $unit $owner $definition $property.ToLowerInvariant() $null $help.$property $helpLine
            }
        }
        foreach ($key in $help.Parameters.Keys) {
            if ($help.Parameters[$key]) {
                $helpLine = $definition.Extent.StartLineNumber
                if ($helpComment) {
                    $match = [regex]::Match($helpComment.Text, "(?im)^\s*\.PARAMETER\s+$([regex]::Escape($key))\b")
                    if ($match.Success) { $helpLine = $helpComment.Extent.StartLineNumber + ([regex]::Matches($helpComment.Text.Substring(0, $match.Index + $match.Length), "`n")).Count }
                }
                Add-Message $unit $owner $definition 'parameter' $null ("-$key`n" + $help.Parameters[$key]) $helpLine
            }
        }
        foreach ($example in $help.Examples) {
            if ($example) { Add-Message $unit $owner $definition 'example' $null $example }
        }
    }
}

foreach ($scope in $functions) {
    if ($scope.scopeType -ne 'function') { continue }
    foreach ($export in $explicitExports) {
        if (($export.file -eq '*' -or $export.file -eq $scope.file) -and $scope.name -like $export.pattern -and $scope.parentId -eq ($units | Where-Object file -EQ $scope.file | Select-Object -First 1).script.id) {
            $scope.exported = $true; $scope.exportReason = $export.reason
            break
        }
    }
}
$incoming = [Collections.Generic.HashSet[string]]::new()
foreach ($scope in $functions) { foreach ($target in $scope.calls) { [void] $incoming.Add($target) } }
if (-not $hasExplicitExports) {
    foreach ($scope in $functions) {
        if ($scope.scopeType -eq 'function' -and -not $incoming.Contains($scope.id)) {
            $scope.exported = $true; $scope.exportReason = 'inferred entry point (no explicit exports found)'
        }
    }
}
foreach ($scope in $functions) {
    if ($scope.scopeType -eq 'script' -and ($scope.messageIds.Count -or $scope.calls.Count)) {
        $scope.exported = $true; $scope.exportReason = 'script / module initialization'
    }
}
$roots = @($functions | Where-Object exported)
$messageById = @{}
foreach ($message in $messages) { $messageById[$message.id] = $message }
foreach ($root in $roots) {
    $seen = [Collections.Generic.HashSet[string]]::new()
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($root.id)
    while ($queue.Count) {
        $id = $queue.Dequeue()
        if (-not $seen.Add($id)) { continue }
        $scope = $byId[$id]
        $scope.rootIds += $root.id
        foreach ($messageId in $scope.messageIds) { $messageById[$messageId].rootIds += $root.id }
        foreach ($target in $scope.calls) { $queue.Enqueue($target) }
    }
}

$groups = @{}
foreach ($message in $messages) {
    # Deliberately conservative: template and case/punctuation variants, not semantic equivalence.
    $key = ($message.text.ToLowerInvariant() -replace '\$\([^)]+\)|\$\{[^}]+\}|\$[\w:.]+|\{\d+[^}]*\}', '<value>' -replace '[^\w<>]+', ' ').Trim()
    if ($key.Length -lt 12) { continue }
    if (-not $groups.ContainsKey($key)) { $groups[$key] = [Collections.Generic.List[object]]::new() }
    $groups[$key].Add($message)
}
$groupCount = 0
foreach ($key in @($groups.Keys | Sort-Object)) {
    if ($groups[$key].Count -gt 1) {
        $groupCount++
        foreach ($message in $groups[$key]) { $message.duplicateGroup = "d-$groupCount" }
    }
}
$data = [ordered]@{
    schemaVersion = 1; generatedAt = [DateTime]::UtcNow.ToString('o')
    name = $inputItem.BaseName; sourcePath = $inputItem.FullName
    stats = @{
        files = $files.Count; functions = @($functions | Where-Object scopeType -NE 'script').Count
        roots = $roots.Count; messages = $messages.Count; duplicateGroups = $groupCount
        dynamicCalls = $dynamicCalls.Count; parseErrors = @($diagnostics | Where-Object severity -EQ 'warning').Count
    }
    functions = @($functions.ToArray()); messages = @($messages.ToArray())
    diagnostics = @($diagnostics.ToArray()); dynamicCalls = @($dynamicCalls.ToArray())
    callSites = @($callSites.ToArray())
    limitations = @(
        'Static analysis only. Module code is never imported or executed.'
        'Call paths show possible reachability, not guaranteed runtime execution. Dynamic invocation, runtime aliases, class dispatch, imports and remoting may hide edges.'
        'Exports are combined across scanned manifests/modules; inferred roots are labeled. Module-loading and manifest restrictions are not simulated.'
        'Variable text uses a possible preceding assignment, not data-flow proof. Localization keys are resolved only when all discovered values agree.'
        'Custom logging commands require -TraceCommand. Resource assemblies and arbitrary object construction are not evaluated.'
        'Duplicate groups normalize placeholders, case and punctuation; they are suggestions, not semantic matches.'
    )
}
$null = New-Item -ItemType Directory -Path $outputFullPath -Force
$json = $data | ConvertTo-Json -Depth 60
$jsonPath = Join-Path $outputFullPath 'pstextmap.json'
[IO.File]::WriteAllText($jsonPath, $json, [Text.UTF8Encoding]::new($false))
$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web\index.html'))
$css = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web\styles.css'))
$js = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web\app.js'))
$modelJs = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'web\model.js'))
# Keep arbitrary source strings from terminating an embedded script element.
$safeJson = $json.Replace('&', '\u0026').Replace('<', '\u003c').Replace('>', '\u003e')
$html = $template.Replace('/*__STYLES__*/', $css).Replace('/*__MODEL__*/', $modelJs).Replace('/*__APP__*/', $js).Replace('{"__DATA__":true}', $safeJson)
$htmlPath = Join-Path $outputFullPath 'PSTextViewer.html'
[IO.File]::WriteAllText($htmlPath, $html, [Text.UTF8Encoding]::new($false))
Write-Host "PSTextViewer: $($messages.Count) messages, $($roots.Count) entry points, $($files.Count) files."
if ($diagnostics.Count) { Write-Warning "$($diagnostics.Count) analysis diagnostics. Inspect Analysis notes in the viewer." }
Write-Host "Viewer: $htmlPath"
Write-Host "Data:   $jsonPath"
if ($Open) { Start-Process $htmlPath }
