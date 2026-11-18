# renrencodex-connect

[中文](#中文) · [English](#english)

## 中文

`renrencodex-connect` 是人人Codex官方 SSH/原生 TCP 端口连接器。它既随 Desktop 安装，也可以脱离
Desktop 独立运行。连接器只接受 `*.preview.renrencodex.com` 官方预览域名，校验系统信任链和主机名，
要求 TLS 1.3 与 `renrencodex-tunnel/1` ALPN，并且只允许在本机回环地址上建立 TCP 转发。

### 下载与完整性校验

- [Windows x64 ZIP](https://renrencodex.com/downloads/renrencodex-connect-windows-x64.zip)
- [macOS Universal tar.gz](https://renrencodex.com/downloads/renrencodex-connect-macos-universal.tar.gz)
- [Linux x64 静态版 tar.gz](https://renrencodex.com/downloads/renrencodex-connect-linux-x64.tar.gz)
- [SHA-256 校验清单](https://renrencodex.com/downloads/renrencodex-connect-SHA256SUMS)

每个压缩包都包含可执行文件、本文档、MIT `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。下载后应先核对
SHA-256；也可以使用 GitHub CLI 核验公开仓库构建工作流生成的来源证明：

```bash
gh attestation verify <archive> --repo renrencodex/desktop
```

当前无证书发行渠道的 Windows 文件没有 Authenticode 签名，macOS 文件使用 ad-hoc 签名且未经 Apple
公证，Linux 压缩包也没有发行版软件仓库签名。只有在确认下载地址、SHA-256 和来源证明后，才应手动
放行系统安全提示；这些完整性证据不能替代操作系统代码签名。

Windows PowerShell 可以这样下载并校验：

```powershell
Invoke-WebRequest https://renrencodex.com/downloads/renrencodex-connect-windows-x64.zip `
  -OutFile renrencodex-connect-windows-x64.zip
Invoke-WebRequest https://renrencodex.com/downloads/renrencodex-connect-SHA256SUMS `
  -OutFile renrencodex-connect-SHA256SUMS

$line = Get-Content .\renrencodex-connect-SHA256SUMS |
  Where-Object { $_ -match '  renrencodex-connect-windows-x64\.zip$' }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash .\renrencodex-connect-windows-x64.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }
```

macOS/Linux 可以在下载目录执行：

```bash
sha256sum -c renrencodex-connect-SHA256SUMS --ignore-missing
```

### 安装

#### Windows

在 PowerShell 中解压，并先从当前目录验证版本：

```powershell
Expand-Archive .\renrencodex-connect-windows-x64.zip -DestinationPath .\renrencodex-connect
Set-Location .\renrencodex-connect
.\renrencodex-connect.exe --version
```

可以一直使用可执行文件的绝对路径，也可以把它复制到用户自己的工具目录并把该目录加入用户 `PATH`。
如果 SmartScreen 或下载隔离标记阻止运行，完成上述完整性校验后再执行：

```powershell
Unblock-File .\renrencodex-connect.exe
```

Windows 10/11 还需要 OpenSSH Client；使用 `ssh -V` 检查，缺少时从“设置 → 系统 → 可选功能”安装。

#### macOS

校验后解压 Universal 二进制。如果 Gatekeeper 因隔离标记阻止这个未公证版本，确认校验通过后再移除
该文件的隔离标记：

```bash
tar -xzf renrencodex-connect-macos-universal.tar.gz
xattr -d com.apple.quarantine renrencodex-connect
sudo install -m 0755 renrencodex-connect /usr/local/bin/renrencodex-connect
renrencodex-connect --version
```

#### Linux

压缩包中的 x64 musl 二进制为静态链接版本：

```bash
tar -xzf renrencodex-connect-linux-x64.tar.gz
sudo install -m 0755 renrencodex-connect /usr/local/bin/renrencodex-connect
renrencodex-connect --version
```

### 使用前提

1. 电脑处于在线状态，目标进程仍在电脑内监听对应 TCP 端口。
2. 在“电脑详情 → 端口”中把 22 端口设为 SSH，或把其他端口设为 TCP。
3. 将该端口从“禁用”改为“放开”，复制页面显示的完整预览域名。
4. 命令只填写主机名，不要带 `https://`、路径或查询参数。

“放开”会允许拿到该域名的人连接目标端口。SSH 仍由电脑内的用户名、密码或密钥认证；其他 TCP
服务应使用自身的认证机制。不使用时应立即把端口恢复为“禁用”。

### SSH

macOS/Linux 或已把连接器加入 `PATH` 的 Windows 环境：

```bash
ssh -o 'ProxyCommand=renrencodex-connect proxy %h' \
  root@22-<machine-id>.preview.renrencodex.com
```

Windows PowerShell 从解压目录执行：

```powershell
$connector = (Resolve-Path .\renrencodex-connect.exe).Path
ssh -o "ProxyCommand=`"$connector`" proxy %h" `
  root@22-<machine-id>.preview.renrencodex.com
```

请把 `root` 换成电脑内部 SSH Server 允许的用户名，把示例域名换成端口页面显示的真实域名。连接器
自动连接公网 443 并完成 TLS/ALPN 握手，不能改成 `ssh -p 443`。

也可以写入 `~/.ssh/config`（Windows 对应 `$HOME\.ssh\config`）：

```sshconfig
Host *.preview.renrencodex.com
  ProxyCommand renrencodex-connect proxy %h
```

Windows 路径包含空格时使用正斜杠和引号，例如：

```sshconfig
Host *.preview.renrencodex.com
  ProxyCommand "C:/Users/<you>/AppData/Local/RenrenCodex/bin/renrencodex-connect.exe" proxy %h
```

### 原生 TCP 转发

把电脑内的 18471 端口转发到本机同名端口：

```bash
renrencodex-connect forward \
  18471-<machine-id>.preview.renrencodex.com \
  --listen 127.0.0.1:18471
```

保持命令运行，然后让本机业务客户端连接 `127.0.0.1:18471`。如果本机端口已占用，可以只修改
`--listen` 的本地端口，例如 `127.0.0.1:28471`；远端端口仍由预览域名前缀决定。按 `Ctrl-C` 停止，
连接器拒绝监听 `0.0.0.0` 或其他非回环地址。

### 命令帮助

```text
renrencodex-connect --help
renrencodex-connect proxy --help
renrencodex-connect forward --help
renrencodex-connect --version
```

连接器与 Desktop 使用相同 SemVer 和同一份源码。独立连接器不会自动更新，请从固定下载地址获取新版。

### 常见错误

| 输出或现象                                               | 原因与处理                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `preview host must ...`                                  | 传入了完整 URL、错误域名、端口或 machine ID。只复制端口页显示的主机名。                  |
| `gateway rejected the connection: DENIED`                | 该域名当前未获授权。确认电脑在线、端口已登记、模式为 SSH/TCP 且状态为“放开”。            |
| `TARGET_UNAVAILABLE`                                     | 电脑通道不可用，或目标进程已停止监听。先恢复电脑通信并刷新端口列表。                     |
| `LIMIT_REACHED`                                          | 当前用户或端口连接数达到上限。关闭不用的 SSH/转发进程后重试。                            |
| `UPSTREAM` / `INTERNAL`                                  | 平台上游暂时失败。稍后重试；持续出现时向平台反馈时间、域名和错误码，不要提交密码或密钥。 |
| `TLS verification failed` / `did not negotiate ... ALPN` | 检查系统时间、DNS、HTTPS/TLS 拦截代理和企业证书策略；连接器不支持跳过证书校验。          |
| `failed to bind ...`                                     | 本地端口已占用、地址无效或权限不足。换一个 `127.0.0.1`/`::1` 端口。                      |
| `ssh: Permission denied`                                 | 隧道已经建立，但电脑内部 SSH 用户、密码或密钥不正确；这不是连接器认证。                  |
| 直接执行 `ssh -p 443` 失败                               | 普通 SSH 不携带平台要求的 TLS SNI 和 ALPN，必须使用 `ProxyCommand`。                     |

## English

`renrencodex-connect` is the official RenrenCodex connector for SSH and native TCP ports. It is
bundled with Desktop and can also run independently. The connector accepts only the official
`*.preview.renrencodex.com` domain, verifies the operating-system trust chain and host name,
requires TLS 1.3 with the `renrencodex-tunnel/1` ALPN, and binds local forwards only to loopback.

### Download and verify integrity

- [Windows x64 ZIP](https://renrencodex.com/downloads/renrencodex-connect-windows-x64.zip)
- [macOS Universal tar.gz](https://renrencodex.com/downloads/renrencodex-connect-macos-universal.tar.gz)
- [Linux x64 static tar.gz](https://renrencodex.com/downloads/renrencodex-connect-linux-x64.tar.gz)
- [SHA-256 checksums](https://renrencodex.com/downloads/renrencodex-connect-SHA256SUMS)

Each archive contains the executable, this README, the MIT `LICENSE`, and
`THIRD_PARTY_NOTICES.md`. Verify SHA-256 after downloading. You can also verify the build
provenance generated by the public repository workflow with GitHub CLI:

```bash
gh attestation verify <archive> --repo renrencodex/desktop
```

The certificate-free channel does not Authenticode-sign the Windows executable. The macOS
executable is ad-hoc signed and not notarized, and the Linux archive is not signed by a
distribution repository. Bypass operating-system warnings only after verifying the download
origin, checksum, and provenance. These integrity checks do not replace OS code signing.

Download and verify with Windows PowerShell:

```powershell
Invoke-WebRequest https://renrencodex.com/downloads/renrencodex-connect-windows-x64.zip `
  -OutFile renrencodex-connect-windows-x64.zip
Invoke-WebRequest https://renrencodex.com/downloads/renrencodex-connect-SHA256SUMS `
  -OutFile renrencodex-connect-SHA256SUMS

$line = Get-Content .\renrencodex-connect-SHA256SUMS |
  Where-Object { $_ -match '  renrencodex-connect-windows-x64\.zip$' }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash .\renrencodex-connect-windows-x64.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch" }
```

On macOS or Linux, run this in the download directory:

```bash
sha256sum -c renrencodex-connect-SHA256SUMS --ignore-missing
```

### Install

#### Windows

Extract the archive in PowerShell and verify the version from the extracted directory:

```powershell
Expand-Archive .\renrencodex-connect-windows-x64.zip -DestinationPath .\renrencodex-connect
Set-Location .\renrencodex-connect
.\renrencodex-connect.exe --version
```

You can keep using the absolute executable path, or copy it into a user-owned tools directory and
add that directory to the user `PATH`. If SmartScreen or the download zone blocks the executable,
verify its integrity first and then run:

```powershell
Unblock-File .\renrencodex-connect.exe
```

Windows 10/11 also needs OpenSSH Client. Check with `ssh -V`; install it from
Settings → System → Optional features if it is missing.

#### macOS

Verify and extract the Universal binary. If Gatekeeper blocks this unnotarized build because of
its quarantine attribute, remove that attribute only after the integrity checks pass:

```bash
tar -xzf renrencodex-connect-macos-universal.tar.gz
xattr -d com.apple.quarantine renrencodex-connect
sudo install -m 0755 renrencodex-connect /usr/local/bin/renrencodex-connect
renrencodex-connect --version
```

#### Linux

The x64 musl executable is statically linked:

```bash
tar -xzf renrencodex-connect-linux-x64.tar.gz
sudo install -m 0755 renrencodex-connect /usr/local/bin/renrencodex-connect
renrencodex-connect --version
```

### Prerequisites

1. The cloud machine is online and the target process is still listening on the TCP port.
2. Set port 22 to SSH, or another port to TCP, under Machine details → Ports.
3. Change the port from Disabled to Open and copy the complete preview hostname shown there.
4. Pass only the hostname, without `https://`, a path, or query parameters.

Open permits anyone who knows the hostname to reach the target port. SSH still authenticates with
the user, password, or key configured inside the cloud machine; other TCP services must provide
their own authentication. Return the port to Disabled when it is no longer needed.

### SSH

On macOS/Linux, or Windows after adding the connector to `PATH`:

```bash
ssh -o 'ProxyCommand=renrencodex-connect proxy %h' \
  root@22-<machine-id>.preview.renrencodex.com
```

From the extracted directory in Windows PowerShell:

```powershell
$connector = (Resolve-Path .\renrencodex-connect.exe).Path
ssh -o "ProxyCommand=`"$connector`" proxy %h" `
  root@22-<machine-id>.preview.renrencodex.com
```

Replace `root` with a user accepted by the SSH server inside the cloud machine, and replace the
example hostname with the value from the port panel. The connector uses public port 443 and
performs the TLS/ALPN handshake itself; do not replace this with `ssh -p 443`.

You can also update `~/.ssh/config` (`$HOME\.ssh\config` on Windows):

```sshconfig
Host *.preview.renrencodex.com
  ProxyCommand renrencodex-connect proxy %h
```

Quote Windows paths that contain spaces and use forward slashes:

```sshconfig
Host *.preview.renrencodex.com
  ProxyCommand "C:/Users/<you>/AppData/Local/RenrenCodex/bin/renrencodex-connect.exe" proxy %h
```

### Native TCP forwarding

Forward remote port 18471 to the same local loopback port:

```bash
renrencodex-connect forward \
  18471-<machine-id>.preview.renrencodex.com \
  --listen 127.0.0.1:18471
```

Keep the process running and connect the local application to `127.0.0.1:18471`. If that local
port is occupied, change only `--listen`, for example to `127.0.0.1:28471`; the preview hostname
still selects the remote port. Press Ctrl-C to stop. The connector rejects `0.0.0.0` and every
other non-loopback listener.

### Command help

```text
renrencodex-connect --help
renrencodex-connect proxy --help
renrencodex-connect forward --help
renrencodex-connect --version
```

The connector shares the Desktop SemVer and source revision. Standalone packages do not update
themselves; download newer versions from the fixed links above.

### Troubleshooting

| Output or symptom                                        | Cause and action                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview host must ...`                                  | A URL, foreign domain, invalid port, or invalid machine ID was passed. Copy only the hostname from the port panel.                          |
| `gateway rejected the connection: DENIED`                | The route is not currently authorized. Check that the machine is online, the port is registered, its mode is SSH/TCP, and it is Open.       |
| `TARGET_UNAVAILABLE`                                     | The machine channel is unavailable or the target process stopped listening. Restore machine connectivity and refresh the port list.         |
| `LIMIT_REACHED`                                          | The per-user or per-port connection limit was reached. Close unused SSH/forward processes and retry.                                        |
| `UPSTREAM` / `INTERNAL`                                  | A platform upstream failed temporarily. Retry later; if it persists, report the time, hostname, and code without sending passwords or keys. |
| `TLS verification failed` / `did not negotiate ... ALPN` | Check system time, DNS, TLS-intercepting proxies, and enterprise certificate policy. Certificate verification cannot be disabled.           |
| `failed to bind ...`                                     | The local port is occupied, invalid, or not permitted. Choose another `127.0.0.1`/`::1` port.                                               |
| `ssh: Permission denied`                                 | The tunnel is established, but the SSH user, password, or key inside the cloud machine is wrong. This is not connector authentication.      |
| Direct `ssh -p 443` fails                                | Plain SSH does not send the required TLS SNI and ALPN; use `ProxyCommand`.                                                                  |
