# Posts a close message to one window, the way Windows itself does. Never forces anything.
# -Kind syscommand : WM_SYSCOMMAND / SC_CLOSE (what Alt+F4, the system menu's Close and the title-bar X send)
# -Kind close      : WM_CLOSE (what the taskbar's "Close window" ends in)
param([long]$Hwnd, [string]$Kind = 'syscommand')
Add-Type -Namespace So4 -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr hWnd);
'@
$h = [System.IntPtr]$Hwnd
if (-not [So4.Win]::IsWindow($h)) { Write-Output 'NOWINDOW'; exit 0 }
if ($Kind -eq 'close') { $ok = [So4.Win]::PostMessage($h, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) }
else { $ok = [So4.Win]::PostMessage($h, 0x0112, [System.IntPtr]0xF060, [System.IntPtr]::Zero) }
Write-Output "POSTED $ok"
