<#
.SYNOPSIS
    dsh-team-member-model 的组合包安装与开关：官方文件零改动，只往 profile 里放一份包并登记为组合包。

.DESCRIPTION
    动作：
      install    用 pnpm 把本目录装成 profile 的 file: 本地依赖（插件页据此把它算作 installed），
                 登记进 dsh.profile.bundles，并清掉历史遗留的 profile 托管块。改完源码后重跑即可同步。
      enable     只把本包登记回 dsh.profile.bundles（等价于界面开关打开）。
      disable    只把本包从 dsh.profile.bundles 移除（等价于界面开关关闭）。
      status     打印依赖登记、组合包登记、包目录、Host 半侧加载结果、策略文件状态。
      uninstall  取消登记，通过 pnpm remove 卸载依赖（策略文件 ~/.dsh/team-member-model/policy.json 保留）。

    为什么必须是 pnpm 依赖而不是手抄目录：「插件 - 已安装」组只展示 installed=true 的组合包，
    客户端过滤是 (installed || optional || error)——dsh-client-ui-plugin-manager client.js 3342-3344。
    手抄目录三样都不占，卡片根本不渲染。file: 本地依赖正是市场安装本地包的落账方式，
    pnpm 用应用自带的 11.7.0，参数（CI=true、--no-frozen-lockfile）与市场一致。

    为什么是「组合包」而不是手写 profile 托管块（2026-07 口径改造，2026-10-09 实施）：
      宿主启动时遍历 profile 的 dsh.profile.bundles，逐个解析包目录、要求包里声明 dsh.bundle，
      再把包内的 cordis.patch.yml 当一层 patch 加载（dsh-app-boot `loadProfileDirectory`）。
      好处：① 插件出现在「插件 → 已安装」里，带官方开关，开关直接改 dsh.profile.bundles
      并热重载该组合包的行，通常**不需要重启**；② 条目随包走，不再手搓 profile 补丁；
      ③ 解析不到包或声明不兼容时宿主只跳过这一层并记录原因，不会让启动失败。
      实测要点：组合包**不需要**是 pnpm 依赖，所以本脚本不碰 dependencies / 锁文件。

    为什么必须复制成「真实目录」而不是符号链接：DSH 桌面版的包解析会对 profile 里的候选做
    realpath 校验，链接到 node_modules 之外的包会被判为无效来源并回退到官方包（甚至直接报错）。
    这条来自 session-rename.ps1 的实测结论，勿改成 mklink。

.PARAMETER Action
    要执行的动作，默认 install。

.PARAMETER Profile
    profile 名，默认取环境变量 DSH_PROFILE，取不到时回退 desktop（当前官方桌面端实际使用的 profile）。

.PARAMETER DshHome
    DSH_HOME，默认取环境变量，否则 ~/.dsh。

.EXAMPLE
    .\team-member-model.ps1 -Action install
#>
[CmdletBinding()]
param(
	[ValidateSet('install', 'enable', 'disable', 'status', 'uninstall')]
	[string]$Action = 'install',
	[string]$Profile = $(if ([string]::IsNullOrWhiteSpace($env:DSH_PROFILE)) { 'desktop' } else { $env:DSH_PROFILE }),
	[string]$DshHome = $(if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $HOME '.dsh' } else { $env:DSH_HOME }),
	[string]$NodePath = '',
	[string]$PnpmPath = ''
)

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$manifestPath = Join-Path $profileDir 'package.json'
$packageName = 'dsh-team-member-model'
$packageDir = Join-Path (Join-Path $profileDir 'node_modules') $packageName
$policyFile = Join-Path $DshHome 'team-member-model\policy.json'
$statusFile = Join-Path $DshHome 'team-member-model\status.json'

# 历史遗留：早期版本把手写 insert 行放在 profile 的 cordis.patch.yml 里。改成组合包后
# 这一块必须清掉，否则同一个 id 会被插入两次。保留常量只为识别与清理，不再写入。
$blockBegin = '# >>> dsh-team-member-model (由 team-member-model.ps1 维护，勿手改此块)'
$blockEnd = '# <<< dsh-team-member-model'

function Read-Text([string]$Path) {
	if (-not (Test-Path -LiteralPath $Path)) { return $null }
	return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
	# 显式 UTF-8 无 BOM：profile 的 JSON/YAML 由 Node 侧解析，带 BOM 会带来不确定性。
	$utf8 = New-Object System.Text.UTF8Encoding($false)
	[System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-ManagedBlockPattern {
	# 必须开单行模式（(?s)）：托管块是多行的，默认的 `.` 不跨行；匹配不上就会每次 install 再追加一份重复块。
	return '(?s)' + [regex]::Escape($blockBegin) + '.*?' + [regex]::Escape($blockEnd) + '\r?\n?'
}

function Test-Profile {
	if (-not (Test-Path -LiteralPath $profileDir)) {
		throw "profile 目录不存在：$profileDir（用 -Profile 指定别的 profile，或先让 dsh 创建它）"
	}
	if (-not (Test-Path -LiteralPath $manifestPath)) {
		throw "profile 清单不存在：$manifestPath"
	}
}

function Test-BundleRegistered([string]$Name) {
	$text = Read-Text $manifestPath
	if ($null -eq $text) { return $false }
	try { $manifest = $text | ConvertFrom-Json } catch { return $false }
	$bundles = $manifest.dsh.profile.bundles
	return ($null -ne $bundles) -and ($bundles -contains $Name)
}

<#
.SYNOPSIS
    在 profile 清单的 dsh.profile.bundles 里增删本包（行级编辑，保留原格式与注释）。

.DESCRIPTION
    刻意不用 ConvertFrom-Json/ConvertTo-Json 往返：那会把整个清单重排格式，
    而这份清单是应用自己维护的。改完立刻用 JSON 解析自检，不合法就整体回滚。
#>
function Update-BundleList([string]$Name, [bool]$Enable) {
	Test-Profile
	$text = Read-Text $manifestPath
	if ($null -eq $text) { throw "找不到 profile 清单：$manifestPath" }

	$eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
	$lines = New-Object System.Collections.Generic.List[string]
	foreach ($line in ($text -split "`r?`n")) { $lines.Add($line) }

	# 定位数组：从含 "bundles": [ 的行，到其后第一个只含 ] 的行。
	$start = -1
	for ($i = 0; $i -lt $lines.Count; $i++) {
		if ($lines[$i] -match '"bundles"\s*:\s*\[') { $start = $i; break }
	}
	if ($start -lt 0) { throw "profile 清单里找不到 dsh.profile.bundles：$manifestPath" }
	$end = -1
	for ($i = $start + 1; $i -lt $lines.Count; $i++) {
		if ($lines[$i].Trim() -eq ']' -or $lines[$i].Trim() -eq '],') { $end = $i; break }
	}
	if ($end -lt 0) { throw "dsh.profile.bundles 数组没有结束的 ]：$manifestPath" }

	# 先剔除同名条目（幂等），再按需追加。
	$entryPattern = '^\s*"' + [regex]::Escape($Name) + '"\s*,?\s*$'
	$kept = New-Object System.Collections.Generic.List[string]
	for ($i = 0; $i -lt $lines.Count; $i++) {
		if ($i -gt $start -and $i -lt $end -and $lines[$i] -match $entryPattern) { continue }
		$kept.Add($lines[$i])
	}

	if ($Enable) {
		$newEnd = -1
		for ($i = $start + 1; $i -lt $kept.Count; $i++) {
			if ($kept[$i].Trim() -eq ']' -or $kept[$i].Trim() -eq '],') { $newEnd = $i; break }
		}
		if ($newEnd -lt 0) { throw "剔除条目后找不到数组结尾：$manifestPath" }
		# 缩进沿用数组内最后一条非空条目；并给它补上逗号。
		$indent = '        '
		for ($i = $newEnd - 1; $i -gt $start; $i--) {
			if ($kept[$i].Trim() -ne '') {
				$indent = ($kept[$i] -replace '^(\s*).*$', '$1')
				if (-not $kept[$i].TrimEnd().EndsWith(',')) { $kept[$i] = $kept[$i].TrimEnd() + ',' }
				break
			}
		}
		$kept.Insert($newEnd, $indent + '"' + $Name + '"')
	}

	Write-Text $manifestPath ($kept -join $eol)
	try {
		$null = (Get-Content -Raw -LiteralPath $manifestPath) | ConvertFrom-Json
	}
	catch {
		Write-Text $manifestPath $text
		throw "改完后 profile 清单不是合法 JSON，已整体回滚：$($_.Exception.Message)"
	}
}

<#
.SYNOPSIS
    清掉 profile 补丁里的历史托管块（早期手写 insert 行）。

.DESCRIPTION
    改成组合包后，条目由包内 cordis.patch.yml 提供；遗留块不清掉会导致同一个 id 被插入两次。
#>
function Remove-LegacyBlock {
	$text = Read-Text $patchPath
	if ($null -eq $text) { return $false }
	if (-not [regex]::IsMatch($text, (Get-ManagedBlockPattern))) { return $false }
	Write-Text $patchPath ([regex]::Replace($text, (Get-ManagedBlockPattern), ''))
	return $true
}

<#
.SYNOPSIS
    解析一个 ≥18 的 node 可执行文件（分发场景：不能假设朋友的 node 装在哪）。

.DESCRIPTION
    候选链按顺序探测，每个都要过版本检查（PATH 上的 node 可能是老版本——本机就是 v14）：
    ① -NodePath 显式指定；② PATH 上的 node；③ NVM_SYMLINK（nvm-windows 当前版本）；
    ④ Program Files\nodejs；⑤ 常见 nvm 目录下的最高版本。
    pnpm 11 需要 node ≥ 18，版本不够就跳过该候选继续找。
#>
function Resolve-NodePath([string]$Explicit) {
	$candidates = @()
	if (-not [string]::IsNullOrWhiteSpace($Explicit)) { $candidates += $Explicit }
	$onPath = Get-Command node -ErrorAction SilentlyContinue
	if ($null -ne $onPath) { $candidates += $onPath.Source }
	if (-not [string]::IsNullOrWhiteSpace($env:NVM_SYMLINK)) { $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe') }
	$candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
	$candidates += 'E:\nodejs\nvm\v22.22.0\node.exe'
	foreach ($candidate in $candidates) {
		if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate)) { continue }
		try {
			$version = (& $candidate --version 2>$null)
			if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)' -and [int]$Matches[1] -ge 18) { return $candidate }
		}
		catch { continue }
	}
	throw "找不到 node >= 18（pnpm 11 的要求）。装一个，或用 -NodePath 显式指定。探测过：$($candidates -join ' ; ')"
}

<#
.SYNOPSIS
    解析 DSH 自带的 pnpm（应用安装位置分每用户/每机器两种）。
#>
function Resolve-PnpmPath([string]$Explicit) {
	$candidates = @()
	if (-not [string]::IsNullOrWhiteSpace($Explicit)) { $candidates += $Explicit }
	$candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs')
	$candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs')
	foreach ($candidate in $candidates) {
		if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) { return $candidate }
	}
	throw "找不到 DSH 自带 pnpm（resources\runtime\pnpm）。DSH 装在哪？或用 -PnpmPath 显式指定。探测过：$($candidates -join ' ; ')"
}

<#
.SYNOPSIS
    跑 DSH 自带的 pnpm（与插件市场同一套参数）。

.DESCRIPTION
    为什么必须走 pnpm 而不是手抄文件：「插件 - 已安装」只展示 installed=true 的组合包，
    installed 的判定是「在 profile 的 dependencies 里」。所以本包必须是 file: 本地依赖，
    由 pnpm 落进 node_modules——手抄目录会绕过 pnpm 的记账，还可能污染硬链接。
    CI=true 防止 TTY 挂起，--no-frozen-lockfile 允许更新锁文件——两条都来自市场的实测参数。
#>
function Invoke-Pnpm([string[]]$PnpmArgs) {
	$node = Resolve-NodePath $NodePath
	$pnpm = Resolve-PnpmPath $PnpmPath
	Write-Host "工具链: node=$node"
	Write-Host "        pnpm=$pnpm"
	$env:CI = 'true'
	& $node $pnpm @PnpmArgs --dir $profileDir
	if ($LASTEXITCODE -ne 0) { throw "pnpm $($PnpmArgs -join ' ') 失败，退出码 $LASTEXITCODE" }
}

<#
.SYNOPSIS
    校验源目录与安装副本内容一致（八个关键文件逐个哈希比对）。
.NOTES
    0.3.0 起 lib\rules.js、0.4.0 起 lib\usage.js 也是「改了就会改变行为」的文件，必须一起比对——
    少比一个文件，硬链接断掉时就会「装完看着成功、真机还是旧逻辑」。
#>
function Test-ContentSynced {
	foreach ($rel in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\rules.js', 'lib\usage.js', 'lib\skill.js', 'lib\client.js', 'skills\model-routing\SKILL.md')) {
		$dstFile = Join-Path $packageDir $rel
		if (-not (Test-Path -LiteralPath $dstFile)) { return $false }
		if ((Get-FileHash -LiteralPath (Join-Path $source $rel) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash) { return $false }
	}
	return $true
}

<#
.SYNOPSIS
    计算从 profile 目录指向本插件源目录的 file: 依赖 spec。

.DESCRIPTION
    分发场景：朋友把包解压到任意位置，不能写死 ../../local-plugins/...。
    相对路径按「公共前缀 + 回退」手工计算（.NET Framework 的 PowerShell 5.1 没有
    Path.GetRelativePath），盘符不同则退回绝对路径；正斜杠是 pnpm 对 file: spec 的要求。
#>
function Get-PluginFileSpec {
	$fromFull = [System.IO.Path]::GetFullPath($profileDir).TrimEnd('\')
	$toFull = [System.IO.Path]::GetFullPath($source).TrimEnd('\')
	$fromParts = $fromFull.Split('\') | Where-Object { $_ -ne '' }
	$toParts = $toFull.Split('\') | Where-Object { $_ -ne '' }
	if ($fromParts.Count -eq 0 -or $toParts.Count -eq 0 -or $fromParts[0] -ne $toParts[0]) {
		return 'file:' + ($toFull -replace '\\', '/')
	}
	$common = 0
	while ($common -lt $fromParts.Count -and $common -lt $toParts.Count -and $fromParts[$common] -eq $toParts[$common]) { $common++ }
	$ups = $fromParts.Count - $common
	$segments = @()
	for ($i = 0; $i -lt $ups; $i++) { $segments += '..' }
	if ($common -lt $toParts.Count) { $segments += $toParts[$common..($toParts.Count - 1)] }
	return 'file:' + ($segments -join '/')
}

<#
.SYNOPSIS
    移走一个目录且**不做永久删除**：优先回收站，退化为本目录内改名隔离。

.DESCRIPTION
    分发场景：朋友的机器上没有本机的 recycle.ps1。退化方案是同卷改名成
    <目录名>.trash-<时间戳>（pnpm 容忍 node_modules 里的陌生目录），保留内容可手工找回。
#>
function Remove-DirNoDelete([string]$Path) {
	if (-not (Test-Path -LiteralPath $Path)) { return }
	$recycle = 'C:\Users\lmy\.agents\tools\recycle.ps1'
	if (Test-Path -LiteralPath $recycle) {
		& pwsh -File $recycle -Path $Path -Recurse
		return
	}
	$trash = "$Path.trash-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
	Move-Item -LiteralPath $Path -Destination $trash
	Write-Host "已隔离（无回收站工具，改名保留内容）：$trash"
}

<#
.SYNOPSIS
    确保依赖行存在且指向当前源目录，然后用 pnpm 把源码装进 profile。

.DESCRIPTION
    file: 依赖指向**本脚本所在目录**（随解压位置走）——市场对本地安装就是这么落账的
    （dshmarket sources.js 的 isLocalSpec/file: 分支）。

    内容同步的真实语义（2026-10-09 实测修正，此前理解有误）：pnpm 对「已满足」的依赖
    **从不重新打包**，file: 目录依赖的内容同步完全依赖硬链接共享 inode。编辑器一旦用
    「写新文件+改名」的原子保存，链接即断，普通 install 不会补。所以装完必须哈希校验；
    不一致就移走安装目录再 install（pnpm 补装缺失包时会从源目录重新打包），仍不一致才报错。
#>
function Sync-PackageFiles {
	Test-Profile
	foreach ($relative in @('lib\index.js', 'lib\client.js', 'package.json', 'cordis.patch.yml')) {
		if (-not (Test-Path -LiteralPath (Join-Path $source $relative))) {
			throw "插件源不完整：找不到 $source\$relative"
		}
	}

	# 依赖行：没有就插入；有但指向别处（包被移动过）就改写为当前位置。JSON 自检失败整体回滚。
	$fileSpec = Get-PluginFileSpec
	$wantedLine = '    "' + $packageName + '": "' + $fileSpec + '",'
	$text = Read-Text $manifestPath
	if ($null -eq $text) { throw "找不到 profile 清单：$manifestPath" }
	if ($text -match '"dsh-team-member-model"\s*:\s*"file:[^"]*"') {
		if ($text -notmatch [regex]::Escape($wantedLine.Trim())) {
			$before = $text
			$text = [regex]::Replace($text, '"dsh-team-member-model"\s*:\s*"file:[^"]*",?', $wantedLine.Trim())
			if ($text -eq $before) { throw '依赖行存在但改写失败（位置移动后未更新指向）' }
			Write-Text $manifestPath $text
			try { $null = (Get-Content -Raw -LiteralPath $manifestPath) | ConvertFrom-Json }
			catch {
				Write-Text $manifestPath $before
				throw "改写依赖后清单不是合法 JSON，已回滚：$($_.Exception.Message)"
			}
			Write-Host "依赖已改写为当前位置：$fileSpec"
		}
	}
	else {
		$anchor = '    "dshmarket": "^1.66.5"'
		if (-not $text.Contains($anchor)) { throw '找不到依赖锚点行（dshmarket）——请把依赖行手动加入 profile package.json' }
		$next = $text.Replace($anchor, $wantedLine + "`r`n" + $anchor)
		Write-Text $manifestPath $next
		try { $null = (Get-Content -Raw -LiteralPath $manifestPath) | ConvertFrom-Json }
		catch {
			Write-Text $manifestPath $text
			throw "写入依赖后清单不是合法 JSON，已回滚：$($_.Exception.Message)"
		}
		Write-Host "已写入 file: 本地依赖：$fileSpec"
	}

	Invoke-Pnpm @('install', '--no-frozen-lockfile')

	# spec 改写场景实测抖动（2026-10-09）：包被移动后第一遍 pnpm 只更新了锁文件、没落包，
	# node_modules 里目录反而消失；紧接着再跑一遍会 "+1 -1" 补齐。所以目录缺失先重试一次。
	if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) {
		Write-Host '第一遍安装后包目录缺失（spec 改写后的已知抖动），重试一次…' -ForegroundColor Yellow
		Invoke-Pnpm @('install', '--no-frozen-lockfile')
		if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'package.json'))) {
			throw "重试后包目录仍不存在：$packageDir"
		}
	}

	# 自愈：校验不过 = 硬链接被编辑器断开 = pnpm 没重新打包。移走重装一次。
	if (-not (Test-ContentSynced)) {
		Write-Host '源码与安装副本不一致（编辑器断开了硬链接），移走重装以重新打包…' -ForegroundColor Yellow
		Remove-DirNoDelete $packageDir
		Invoke-Pnpm @('install', '--no-frozen-lockfile')
		if (-not (Test-ContentSynced)) { throw "重装后内容仍不同步：$packageDir（检查 pnpm 输出）" }
		Write-Host '已重新打包并同步'
	}
	else {
		Write-Host '内容校验：源码与安装副本一致'
	}

	Get-ChildItem -LiteralPath $packageDir -Recurse -File |
		ForEach-Object { Write-Host ("  {0,8}  {1}" -f $_.Length, $_.FullName.Substring($packageDir.Length + 1)) }
	Write-Host "已通过 pnpm 同步插件包：$packageDir"
}

function Invoke-Install {
	Sync-PackageFiles
	if (Remove-LegacyBlock) { Write-Host '已清掉 profile 补丁里的历史托管块（改由包内 cordis.patch.yml 提供条目）' }
	else { Write-Host 'profile 补丁里没有历史托管块（正常）' }
	Update-BundleList $packageName $true
	Write-Host '已登记为组合包：dsh.profile.bundles'
	Write-Host ''
	Write-Host '下一步：重启 DSH Desktop 让宿主重新加载组合（宿主进程启动时才读包）。'
	Write-Host '之后启停可以直接用「插件 - 已安装」里的开关，通常无需重启。'
}

function Invoke-Enable {
	Update-BundleList $packageName $true
	Write-Host '已登记为组合包（等价于界面开关打开）。'
	Write-Host '界面上操作会热重载该组合包的行；命令行改文件通常需要重启生效。'
}

function Invoke-Disable {
	Update-BundleList $packageName $false
	Write-Host '已取消登记（等价于界面开关关闭）：宿主不再加载本插件，官方行为原样恢复。'
	Write-Host '包目录与策略文件都保留；界面上重新打开开关即可恢复。'
}

function Invoke-Status {
	$depText = Read-Text $manifestPath
	$hasDep = $null -ne $depText -and $depText -match '"dsh-team-member-model"\s*:\s*"file:'
	Write-Host "profile          : $profileDir"
	Write-Host "依赖登记         : $(if ($hasDep) { '已登记（file: 本地依赖 → 界面里算 installed）' } else { '未登记（「插件-已安装」不会显示它！跑 -Action install）' })"
	Write-Host "组合包登记       : $(if (Test-BundleRegistered $packageName) { '已登记（dsh.profile.bundles）' } else { '未登记（需 -Action install，或在界面里打开开关）' })"
	Write-Host "插件包目录       : $(if (Test-Path -LiteralPath (Join-Path $packageDir 'package.json')) { '存在' } else { '缺失（组合包会被跳过并记录原因）' })"
	Write-Host "组合包声明       : $(if (Test-Path -LiteralPath (Join-Path $packageDir 'cordis.patch.yml')) { '存在（包内 cordis.patch.yml）' } else { '缺失（会报 declares no dsh.bundle）' })"
	Write-Host "设置页脚本       : $(if (Test-Path -LiteralPath (Join-Path $packageDir 'lib\client.js')) { '存在' } else { '缺失（设置页不会出现）' })"
	$patchText = Read-Text $patchPath
	$hasLegacy = $null -ne $patchText -and [regex]::IsMatch($patchText, (Get-ManagedBlockPattern))
	Write-Host "历史托管块       : $(if ($hasLegacy) { '仍存在（跑一次 install 会清掉，否则条目重复）' } else { '无（正常）' })"

	# 状态文件是判断「Host 半侧到底加载没有」的唯一直接证据：客户端半侧独立组合，
	# 页面能打开并不代表工具与路由已注册（首版踩过：页面正常 + 接口 404）。
	if (Test-Path -LiteralPath $statusFile) {
		try {
			$status = Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
			if ($status.mode -eq 'ok') {
				# 0.6.x 的 status.json 只写 members/bindings/rules，旧版才写 routes；两者都兼容显示，
				# 否则在 0.6.x 上会打印出「白名单  条」这种看着像坏了的空值。时间统一转本地时区。
				Write-Host "Host 半侧       : 已加载（$(if ($status.at -is [datetime]) { $status.at.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } else { $status.at })，$(if ($null -ne $status.members) { '成员 {0} 个 / 绑定 {1} 个 / 规则 {2} 条' -f $status.members, $status.bindings, $status.rules } elseif ($null -ne $status.routes) { '白名单 {0} 条' -f $status.routes } else { '摘要缺失' })，包装 $($status.wrapper)）"
			}
			else {
				Write-Host "Host 半侧       : 启动失败 —— $($status.error)" -ForegroundColor Red
			}
		}
		catch {
			Write-Host "Host 半侧       : 状态文件不可解析：$statusFile" -ForegroundColor Yellow
		}
	}
	else {
		Write-Host "Host 半侧       : 尚无记录（还没重启过，或插件未加载）"
	}
	Write-Host "策略文件         : $(if (Test-Path -LiteralPath $policyFile) { $policyFile } else { '尚未生成（首次保存或首次安装种子后出现）' })"
	Write-Host "源目录           : $source"
}

function Invoke-Uninstall {
	if (Test-BundleRegistered $packageName) {
		Update-BundleList $packageName $false
		Write-Host '已取消组合包登记'
	}
	if (Remove-LegacyBlock) { Write-Host '已清掉 profile 补丁里的历史托管块' }

	$depText = Read-Text $manifestPath
	if ($null -ne $depText -and $depText -match '"dsh-team-member-model"\s*:\s*"file:') {
		# pnpm remove 会同步清掉 node_modules 里的包并更新锁文件——由 pnpm 记账的目录交给 pnpm 收，
		# 不手抄回收（避免 pnpm 元数据与实际文件不一致）。
		Invoke-Pnpm @('remove', 'dsh-team-member-model')
		Write-Host '已通过 pnpm remove 卸载依赖与包目录'
	}
	elseif (Test-Path -LiteralPath $packageDir) {
		# 兜底：目录不是 pnpm 装的（历史手抄），移走且不永久删除（朋友机器上没有本机的回收工具）。
		Remove-DirNoDelete $packageDir
		Write-Host "包目录已移走：$packageDir"
	}
	Write-Host "策略文件保留未动：$policyFile（如需清理请自行送回收站）"
	Write-Host '重启 DSH Desktop 生效。'
}

switch ($Action) {
	'install' { Invoke-Install }
	'enable' { Invoke-Enable }
	'disable' { Invoke-Disable }
	'status' { Invoke-Status }
	'uninstall' { Invoke-Uninstall }
}
