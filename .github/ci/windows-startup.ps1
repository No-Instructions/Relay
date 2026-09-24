# Windows VM startup script, passed as windows-startup-script-ps1 metadata by
# lane-windows.sh and bake-windows-image.sh. The GCE Windows guest agent does
# not wire ssh-keys metadata into OpenSSH, so this installs OpenSSH Server and
# authorizes exactly the key passed in the relay-ssh-pubkey metadata attribute
# for a local administrator, `relay`. Each stage logs a RELAY-STARTUP marker to
# the serial console, so a failed boot can be diagnosed from
# get-serial-port-output.
$ErrorActionPreference = "Continue"
function Log($m) { Write-Output "RELAY-STARTUP: $m" }
Log "startup begin"

# Add-WindowsCapability -Online is synchronous but can transiently
# fail before the FoD source is reachable; retry until sshd exists.
for ($i = 1; $i -le 6; $i++) {
  if (Get-Service sshd -ErrorAction SilentlyContinue) { break }
  try { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }
  catch { Log "Add-WindowsCapability attempt $i failed: $_" }
  Start-Sleep -Seconds 10
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Log "ERROR: sshd not installed after retries" }

Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service sshd -ErrorAction SilentlyContinue
Log "sshd install+start done"

if (-not (Get-NetFirewallRule -Name sshd-relay -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name sshd-relay -DisplayName 'OpenSSH Server (relay)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue

if (Test-Path "HKLM:\SOFTWARE\OpenSSH") {
  New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
    -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -PropertyType String -Force | Out-Null
}

# Access is SSH-key-only, so the local account password is a throwaway
# generated at boot and never persisted or logged.
$rand = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
$pw = ConvertTo-SecureString ($rand + '!Aa9') -AsPlainText -Force
if (-not (Get-LocalUser -Name relay -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name relay -Password $pw -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  Add-LocalGroupMember -Group Administrators -Member relay
}
Log "relay user ready"

$pub = $null
try {
  $pub = Invoke-RestMethod -Headers @{'Metadata-Flavor'='Google'} `
    -Uri 'http://metadata.google.internal/computeMetadata/v1/instance/attributes/relay-ssh-pubkey'
} catch { Log "ERROR: could not fetch relay-ssh-pubkey: $_" }

New-Item -ItemType Directory -Path "C:\ProgramData\ssh" -Force | Out-Null
$adminKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
if ($pub) {
  Set-Content -Path $adminKeys -Value $pub -Encoding ascii
  icacls $adminKeys /inheritance:r | Out-Null
  icacls $adminKeys /grant "SYSTEM:F" | Out-Null
  icacls $adminKeys /grant "BUILTIN\Administrators:F" | Out-Null
  Log "authorized_keys written (len=$($pub.Length))"
} else {
  Log "ERROR: no pubkey; authorized_keys not written"
}

Restart-Service sshd -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "C:\relay-e2e-testing" -Force | Out-Null
$svc = Get-Service sshd -ErrorAction SilentlyContinue
Log "startup complete; sshd status=$($svc.Status)"
