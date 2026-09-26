<#
.SYNOPSIS
    Executa todos os testes do MangaTranslator em um único comando.
.DESCRIPTION
    Localiza automaticamente o interpretador Node.js ou VS Code no sistema
    e dispara a suíte completa de testes (Jest Unitários, Integração e Visuais v3/v4).
.EXAMPLE
    .\run
    .\run all test
    .\run --e2e
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

# Localizar executável Node / VS Code
$nodePath = $null
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodePath = (Get-Command node).Source
} elseif (Test-Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe") {
    $nodePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
    $env:ELECTRON_RUN_AS_NODE = "1"
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $nodePath = "C:\Program Files\nodejs\node.exe"
} else {
    Write-Host "[ERRO] Não foi possível encontrar o Node.js nem o VS Code no sistema." -ForegroundColor Red
    exit 1
}

$testScript = Join-Path $PSScriptRoot "tests\run-all-tests.js"
& $nodePath $testScript @Arguments
exit $LASTEXITCODE
