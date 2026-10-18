# Generate the Chinese speech sample used by asrtest.js (Windows SAPI, offline).
#
# NOTE: this script must stay pure ASCII. Windows PowerShell 5.1 reads .ps1 as GBK,
# so any non-ASCII byte (even inside a comment) can break the parser.
# The Chinese sentence lives in speech_text.txt and is read back as UTF-8.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make_speech.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/make_speech.ps1 -Out "D:\tmp\speech_zh.wav"
param([string]$Out = "$env:LOCALAPPDATA\hermes\cache\scratch\litecut_test\speech_zh.wav")

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$text = (Get-Content -Path (Join-Path $here 'speech_text.txt') -Encoding UTF8 -Raw).Trim()

Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $s.SelectVoice('Microsoft Huihui Desktop')   # built-in Chinese female voice on Win10
} catch {
    $zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
    if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) } else { Write-Error 'no Chinese SAPI voice installed' }
}
$s.Rate = 0
$voice = $s.Voice.VoiceInfo.Name

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$s.SetOutputToWaveFile($Out)
$s.Speak($text)
$s.Dispose()

$fi = Get-Item $Out
Write-Output ("OK {0} ({1} bytes, voice={2})" -f $fi.FullName, $fi.Length, $voice)