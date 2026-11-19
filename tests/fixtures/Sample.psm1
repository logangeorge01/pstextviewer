# The extractor must never run this file.
throw 'FIXTURE MUST NEVER EXECUTE'

function Get-Widget {
    <#
    .SYNOPSIS
    Gets a widget.
    .DESCRIPTION
    Looks up a widget and explains failures.
    .PARAMETER Name
    The widget name.
    .EXAMPLE
    Get-Widget -Name Example
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(HelpMessage = 'Choose a widget name.')][string] $Name)
    if ($Name) {
        Invoke-Shared -Name $Name
        Invoke-RemoteHelper -Name $Name
    } elseif ($Force) {
        Write-Warning -WarningAction Continue -Message 'Forced widget lookup.'
    } else {
        Write-Warning 'No widget name.'
    }
    if ($PSCmdlet.ShouldProcess($Name, 'Read widget')) {
        Write-Information 'Reading widget.'
    }
}

function Set-Widget {
    Invoke-Shared 'example'
    Invoke-RemoteHelper 'example'
    Write-Error -ErrorAction Continue -Message 'Error: Could not update widget!!'
    Write-Verbose ('Widget {1} cannot be updated.' -f 'first')
    Write-Verbose ('Escaped {{1}} and {0}.' -f 'first')
    $failure = "Unable to update $Name."
    throw $failure
}

function Invoke-Shared {
    param($Name)
    try {
        if (-not $Name) {
            throw [System.ArgumentException]::new("Widget '$Name' was not found.")
        }
        Write-Warning $LocalizedData.MissingWidget
        $warning = 'A shared warning.'
        Write-Warning $warning
        Trace-Widget -Message "Working on $Name."
        Invoke-Cycle
    } catch [System.IO.IOException] {
        if (-not $Force) {
            Write-Error 'Cannot read widget.'
        }
    }
    switch ($Name) {
        'legacy' { Write-Warning 'Legacy widget.' }
        default { Write-Debug 'Modern widget.' }
    }
    $PSCmdlet.ThrowTerminatingError($errorRecord)
    & $dynamicCommand 'not statically resolved'
}

function Invoke-Cycle {
    Invoke-Shared
}

function Invoke-Unreachable {
    Write-Warning 'An orphaned warning.'
    $e = [InvalidOperationException]::new('Bad widget state.')
    $o = New-Object System.Exception -ArgumentList 'Legacy exception text.'
    try { Invoke-Unknown } catch { throw }
    function Invoke-Nested {
        Write-Verbose 'Only belongs to nested function.'
    }
}

Set-Alias -Name ww -Value Write-Warning
function Get-Aliased {
    ww 'Warning via static alias.'
}
Export-ModuleMember -Function Get-Widget, Set-Widget, Get-Aliased
