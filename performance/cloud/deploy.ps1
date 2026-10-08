param([switch]$Check)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
$previousToken = $env:CLOUDFLARE_API_TOKEN
try {
    # Keep route assets available on fresh checkouts and refresh them on later deployments.
    $taskTimetablePath = Join-Path $PSScriptRoot '../public/timetables/3-376.json'
    if (-not (Test-Path -LiteralPath $taskTimetablePath) -or (Get-Item -LiteralPath $taskTimetablePath).LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)) {
        & (Join-Path $PSScriptRoot '../../scripts/refresh-trip-timetables.ps1')
    }
    if (-not $env:CLOUDFLARE_API_TOKEN) {
        $sessionPath = Join-Path $env:APPDATA 'xdg.config\cloudflare\config\default.json'
        if (Test-Path -LiteralPath $sessionPath) {
            $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
            if (-not $Check -and $session.expiration_time -and ([DateTimeOffset]$session.expiration_time) -le [DateTimeOffset]::UtcNow) {
                # The cf CLI refreshes its OAuth session; never send an expired token to Wrangler.
                if (Get-Command cf -ErrorAction SilentlyContinue) { & cf auth whoami | Out-Null }
                elseif (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm dlx cf auth whoami | Out-Null }
                else { throw 'The cf CLI is needed to refresh the saved Cloudflare session.' }
                if ($LASTEXITCODE -ne 0) { throw 'The Cloudflare session could not be refreshed.' }
                $session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
            }
            if ($session.oauth_token) { $env:CLOUDFLARE_API_TOKEN = $session.oauth_token }
        }
    }
    # Secrets stay in process memory; Wrangler uses this project's account/bindings.
    $taskScript = if ($Check) { 'check' } else { 'deploy' }
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        & pnpm run $taskScript
    } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
        & npm run $taskScript
    } else {
        throw 'Install pnpm or npm before running this deployment script.'
    }
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare $taskScript failed. See the CLI output above." }
} finally {
    $env:CLOUDFLARE_API_TOKEN = $previousToken
    Pop-Location
}
