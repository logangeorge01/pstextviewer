function Invoke-RemoteHelper {
    param($Name)
    if ($Name) {
        Write-Warning 'Remote helper found a named widget.'
    } else {
        Write-Warning 'Remote helper needs a widget name.'
    }
    Invoke-RemoteCycle
}

function Invoke-RemoteCycle {
    Invoke-RemoteHelper
}
