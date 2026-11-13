$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$T = 'C:\bfi_sig_test'
New-Item -ItemType Directory -Force -Path "$T\installer", "$T\download" | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Verified($url, $sha256) {
    $f = Join-Path "$T\download" ([IO.Path]::GetFileName($url))
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $f
    if ((Get-FileHash $f -Algorithm SHA256).Hash.ToLower() -ne $sha256) { throw "SHA256 mismatch: $url" }
    $f
}
function Expand-Flat($zip, $dest) {   # like '7za e': no folders
    $a = [IO.Compression.ZipFile]::OpenRead($zip)
    foreach ($e in $a.Entries) { if ($e.Name) { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $dest $e.Name), $true) } }
    $a.Dispose()
}
Expand-Flat (Get-Verified 'https://software.bigfix.com/download/tema/scanner/11.0.44.0-20260915-1200/w64-ix86_11.0.44.0.zip' 'fcf79e161867103d5223a26ed13f012a031528a28bf24de7e05277c57cc8254c') "$T\installer"
$p = Start-Process -FilePath "$T\installer\wcitinst.exe" -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$T\installer\installCITlog.txt" `
    -ArgumentList @('i', 'BFI-PRIVATE', '-s', "`"$T\installer\CIT_win64.spb`"", '-d', "`"$T\cit`"", '-c', "`"$T\cit\logs`"", '-p')
"wcitinst exit code: $($p.ExitCode)"   # 0, log ends with "Done."
if (-not (Get-ChildItem "$env:WINDIR\System32" -Filter 'api-ms-win-crt*' -ErrorAction SilentlyContinue)) {
    Expand-Flat (Get-Verified 'https://software.bigfix.com/download/tema/scanner/api-ms-win_redist_dlls_x64.zip' '1dff7809092e300b023eb61646fa5e428bd4c2479e6363aae872ede8264ff581') "$T\cit\bin"
}
