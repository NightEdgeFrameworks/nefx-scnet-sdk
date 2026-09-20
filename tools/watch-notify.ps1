<#
.SYNOPSIS
  定时给一个 SCNet 作业做体检，并把结果推到 QQ。

.DESCRIPTION
  这是"定时任务"这一层唯一的可复用脚本：它本身**不做判断**，判断全在
  `scnet watch`（可复用代码）里；这里只负责
    取一次样 → 把 JSON 转成人能读的中文短句 → 落盘 → 推送。

  为什么要单拆成脚本：我（agent）在两个回合之间不存在，没有常驻进程可以"盯着"。
  所谓"定时监控"实际是——计划任务每隔 N 分钟起一次这个脚本，采一次样就走。
  汇报时必须这么讲，不能说成"我在看着"。

.PARAMETER JobId
  作业号。也可以用 -JobFile 指向一个只写一行的文本文件（里面是作业号），
  这样长任务开始时不需要改计划任务。

.PARAMETER Steps
  这批要跑多少个时间步；用来算"本批完成了百分之几"。不给就只有绝对步号。

.PARAMETER SayPath
  QQ 出站脚本 say.py 的路径（见 D260913-qqbot/tools/say.py）。
  给了才推送；不给就只落盘。

.PARAMETER LogPath
  追加写一行的日志文件。默认 %LOCALAPPDATA%\scnet-watch\watch.log。

.PARAMETER Strict
  有风险时退出码 1（给别的自动化用）。默认永远 0——推送失败不该改变业务语义。

.EXAMPLE
  pwsh -File tools/watch-notify.ps1 -JobFile ..\D260914-scnet-automation\phase3\current-job.txt -Steps 10000
#>
[CmdletBinding()]
param(
  [string]$JobId,
  [string]$JobFile,
  [int]$Steps = 0,
  [string]$SayPath,
  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'scnet-watch\watch.log'),
  [string]$ClientRoot,
  [switch]$Strict,
  [switch]$NoPush
)

$ErrorActionPreference = 'Continue'

function Resolve-JobId {
  if ($JobId) { return $JobId.Trim() }
  if ($JobFile -and (Test-Path $JobFile)) {
    $line = (Get-Content $JobFile -First 1).Trim()
    if ($line) { return $line }
  }
  return $null
}

function Get-ClientRoot {
  if ($ClientRoot) { return $ClientRoot }
  # tools/ 的上一级就是仓库根
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Write-Log([string]$text) {
  $dir = Split-Path -Parent $LogPath
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -Path $LogPath -Value "[$stamp] $text" -Encoding utf8
}

function ConvertTo-QqText($w) {
  # QQ 不渲染 markdown：全部写成"项目：值"的短行，不要表格、不要代码块。
  $lines = @()
  $state = if ($w.state) { [string]$w.state } else { '未知' }
  $verdict = if ($w.verdict) { [string]$w.verdict } else { '' }
  $lines += "作业 $($w.jobId)：$state（$verdict）"

  $min = [math]::Round(([double]$w.elapsedSec) / 60, 1)
  $leftMin = [math]::Round(([double]$w.walltimeLeftSec) / 60)
  $lines += "已跑：$min 分钟；墙钟还剩：$leftMin 分钟"
  if ($w.nodes) { $lines += "节点：$($w.nodes)" }

  if ($w.progress) {
    $p = $w.progress
    $stepText = "第 $($p.step) 步"
    if ($p.flowTime) { $stepText += "（物理时间 $($p.flowTime)s）" }
    if ($p.targetStep) { $stepText += "；本批进度 $($p.pct)%（$($p.stepsDoneInBatch)/$($p.targetStep - $p.step + $p.stepsDoneInBatch)）" }
    $lines += "进度：$stepText"
  } else {
    $lines += '进度：还没读到 .trn（可能刚起步）'
  }

  if ($w.rate) { $lines += "速率：$([math]::Round([double]$w.rate, 2)) 步/分钟" }
  if ($w.eta) { $lines += "预计完成：$($w.eta)" }

  $risks = @($w.risks)
  if ($risks.Count -gt 0) {
    $lines += '⚠️ 需要看的地方：'
    foreach ($r in $risks) { $lines += "· $r" }
  } else {
    $lines += '没有发现风险。'
  }
  $lines += '（这是定时脚本采的一次样，不是有人一直盯着）'
  return ($lines -join "`n")
}

$job = Resolve-JobId
if (-not $job) {
  Write-Log '没有拿到作业号（-JobId / -JobFile 都没给）——本次跳过'
  if ($Strict) { exit 2 } else { exit 0 }
}

$root = Get-ClientRoot
$cli = Join-Path $root 'src\cli.ts'
if (-not (Test-Path $cli)) {
  Write-Log "找不到客户端入口：$cli"
  if ($Strict) { exit 3 } else { exit 0 }
}

$cliArgs = @($cli, 'watch', $job, '--json', '--strict')
if ($Steps -gt 0) { $cliArgs += @('--steps', "$Steps") }

# 注意：这里必须把 node 的 stdout/stderr 都收下来，所以用 & 而不是 Start-Process。
$raw = & node @cliArgs 2>&1
$code = $LASTEXITCODE

$text = ($raw | Out-String).Trim()
$json = $null
$start = $text.IndexOf('{')
if ($start -ge 0) {
  try { $json = $text.Substring($start) | ConvertFrom-Json } catch { $json = $null }
}

if (-not $json) {
  Write-Log "watch 没吐 JSON（退出码 $code）：$text"
  if ($Strict) { exit 4 } else { exit 0 }
}

$msg = ConvertTo-QqText $json
Write-Log ($msg -replace "`r?`n", ' | ')

if ($SayPath -and -not $NoPush -and (Test-Path $SayPath)) {
  # 推送失败不影响业务语义：只记日志。
  try {
    $env:PYTHONIOENCODING = 'utf-8'
    & python $SayPath $msg 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Log "推送失败（say.py 退出码 $LASTEXITCODE）" }
  } catch {
    Write-Log "推送抛异常：$($_.Exception.Message)"
  }
}

if ($Strict -and $code -ne 0) { exit $code }
exit 0
