$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'Video Playback Reminder - QQ Mail Bridge' -ForegroundColor Cyan
Write-Host 'Use the QQ Mail authorization code, not your QQ login password.' -ForegroundColor Yellow
Write-Host ''

$sender = Read-Host 'Sender QQ mailbox (for example 123456@qq.com)'
if ($sender -notmatch '^[1-9]\d{4,12}@qq\.com$') {
  throw 'Please enter a valid QQ mailbox address.'
}

$authorizationCode = Read-Host 'QQ Mail authorization code' -AsSecureString
$authorizationCodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($authorizationCode)
try {
  $authorizationCodeText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($authorizationCodePointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($authorizationCodePointer)
}

if ([string]::IsNullOrWhiteSpace($authorizationCodeText)) {
  throw 'The QQ Mail authorization code cannot be empty.'
}

$randomBytes = New-Object byte[] 24
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomNumberGenerator.GetBytes($randomBytes)
} finally {
  $randomNumberGenerator.Dispose()
}
$bridgeToken = [Convert]::ToBase64String($randomBytes)

$env:QQ_MAIL_FROM = $sender.Trim()
$env:QQ_MAIL_AUTH_CODE = $authorizationCodeText.Trim()
$env:QQ_MAIL_BRIDGE_TOKEN = $bridgeToken

Write-Host ''
Write-Host 'Copy this bridge token into the extension panel:' -ForegroundColor Green
Write-Host $bridgeToken -ForegroundColor White
Write-Host ''
Write-Host 'The bridge is running. Keep this window open.' -ForegroundColor Cyan
node "$PSScriptRoot\qq-mail-bridge.js"
