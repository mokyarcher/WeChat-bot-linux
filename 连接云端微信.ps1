# 保持此窗口打开，通过 SSH 访问服务器本机监听的微信桌面与管理面板。
$ErrorActionPreference = 'Stop'
Write-Host '微信桌面：http://127.0.0.1:16080/vnc.html?autoconnect=1&resize=scale'
Write-Host '管理面板：http://127.0.0.1:18787/'
$taskTunnel = Get-ScheduledTask -TaskName 'WeChatBotTunnel' -ErrorAction SilentlyContinue
if ($taskTunnel) {
    if ($taskTunnel.State -ne 'Running') {
        Start-ScheduledTask -TaskName 'WeChatBotTunnel'
    }
    Write-Host '后台隧道任务已启动，此窗口可以关闭。'
    return
}
Write-Host '当前电脑尚未配置后台任务，请保持窗口打开；按 Ctrl+C 断开隧道。'
& ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 `
    -L 127.0.0.1:16080:127.0.0.1:6080 `
    -L 127.0.0.1:18787:127.0.0.1:8787 root@111.229.166.216
