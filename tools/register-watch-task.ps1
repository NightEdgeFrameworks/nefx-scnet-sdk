<#
.SYNOPSIS
  注册（或更新 / 删除）"定时给某个 SCNet 作业体检"的 Windows 计划任务。

.DESCRIPTION
  真正干活的是 tools/watch-notify.ps1；这里只把计划任务接上去。
  默认每 30 分钟一次、无限期重复；作业跑完（COMPLETED/FAILED/…）之后
  脚本仍在跑，但 watch 会报"终态"，你可以随手把任务删掉：
      pwsh -File tools/register-watch-task.ps1 -Remove

.PARAMETER JobId / -JobFile
  传给 watch-notify.ps1 的作业来源。推荐 -JobFile：长任务开始时改一行文本即可，
  不用动计划任务。

.PARAMETER IntervalMinutes
  采样间隔，默认 30。

.PARAMETER SayPath
  QQ 出站脚本路径。给了才会推。

.PARAMETER TaskName
  计划任务名，默认 SCNET-Watch-<JobId>。

.EXAMPLE
  pwsh -File tools/register-watch-task.ps1 -JobFile ..\D260914-scnet-automation\phase3\current-job.txt -Steps 10000 -SayPath ..\D260913-qqbot\tools\say.py
#>
[CmdletBinding()]
param(
  [string]$JobId,
  [string]$JobFile,
  [int]$Steps = 0,
  [int]$IntervalMinutes = 30,
  [string]$SayPath,
  [string]$TaskName,
  [switch]$Remove,
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$watcher = Join-Path $here 'watch-notify.ps1'
if (-not (Test-Path $watcher)) { throw "找不到 $watcher" }

if (-not $TaskName) {
  $key = if ($JobId) { $JobId } elseif ($JobFile) { 'jobfile' } else { 'unknown' }
  $TaskName = "SCNET-Watch-$key"
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "已删除计划任务 $TaskName"
  } else {
    Write-Output "没有这个计划任务：$TaskName"
  }
  exit 0
}

if (-not $JobId -and -not $JobFile) { throw '必须给 -JobId 或 -JobFile' }

$argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$watcher`"")
if ($JobId) { $argList += @('-JobId', $JobId) }
if ($JobFile) {
  $full = (Resolve-Path $JobFile -ErrorAction SilentlyContinue)
  if (-not $full) { throw "JobFile 不存在：$JobFile" }
  $argList += @('-JobFile', "`"$($full.Path)`"")
}
if ($Steps -gt 0) { $argList += @('-Steps', "$Steps") }
if ($SayPath) {
  $sayFull = (Resolve-Path $SayPath -ErrorAction SilentlyContinue)
  if (-not $sayFull) { throw "SayPath 不存在：$SayPath" }
  $argList += @('-SayPath', "`"$($sayFull.Path)`"")
}

$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }

$action = New-ScheduledTaskAction -Execute $pwshExe -Argument ($argList -join ' ') -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Write-Output "将注册计划任务：$TaskName"
Write-Output "  每 $IntervalMinutes 分钟跑一次：$pwshExe $($argList -join ' ')"
if ($WhatIfOnly) { exit 0 }

# 先删后建，保证幂等（Get-ScheduledTask 存在时 Register 会报已存在）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'SCNet 作业体检：调 scnet watch 采样一次并推送（判断逻辑在客户端里）' | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
Write-Output "已注册：$($t.TaskName)  状态=$($t.State)"
Write-Output "手动跑一次：Start-ScheduledTask -TaskName $TaskName"
Write-Output "删掉它  ：pwsh -File tools/register-watch-task.ps1 -TaskName $TaskName -Remove"
