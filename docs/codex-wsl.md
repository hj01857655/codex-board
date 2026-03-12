# 在 WSL 中使用 Codex（Ubuntu 版，官方流程整理）

本指南基于 OpenAI 官方 Windows 文档，整理成 WSL 的最小可用步骤（发行版：Ubuntu）。

## 1. 安装并进入 WSL

在管理员 PowerShell 或 Windows Terminal 中执行：

```powershell
wsl --install
wsl
```

## 1.5 Ubuntu 基础依赖（可选，非官方补充）

以下是常见的最小依赖，便于后续安装 nvm/Node 与克隆仓库：

`ash
sudo apt update
sudo apt install -y curl git ca-certificates build-essential
`
## 1.6 Ubuntu 国内镜像与 npm 源（可选，非官方补充）

如需加速下载，可选择切换 Ubuntu 源与 npm registry（示例，按你的内网规则调整）：

`ash
# APT 源（示例：清华源）
# 注意：请根据你的 Ubuntu 版本与公司策略修改
# sudo sed -i 's@http://archive.ubuntu.com/ubuntu/@https://mirrors.tuna.tsinghua.edu.cn/ubuntu/@g' /etc/apt/sources.list
# sudo apt update

# npm 源（示例）
npm config set registry https://registry.npmmirror.com
`

如果你在公司内网，请用内网镜像地址替换以上示例。
## 1.7 固定 Node 版本与代理环境（可选，非官方补充）

固定 Node 版本并设为默认：

`ash
nvm install 22
nvm alias default 22
node -v
`

如需代理（示例）：

`ash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
`

如果需要持久化，可写入 ~/.bashrc 或 ~/.zshrc。
## 1.8 npm 代理配置（可选，非官方补充）

企业代理环境下可设置 npm 代理（示例）：

`ash
npm config set proxy http://127.0.0.1:7890
npm config set https-proxy http://127.0.0.1:7890
npm config set registry https://registry.npmmirror.com
`

如需取消代理：

`ash
npm config delete proxy
npm config delete https-proxy
`
## 1.9 Git 与 curl 代理（可选，非官方补充）

Git 代理（示例）：

`ash
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
`

取消 Git 代理：

`ash
git config --global --unset http.proxy
git config --global --unset https.proxy
`

curl 代理（示例）：

`ash
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
`

如需持久化可写入 ~/.bashrc 或 ~/.zshrc。
## 1.10 SSH 代理（可选，非官方补充）

如果公司要求通过代理访问 Git（SSH），可在 ~/.ssh/config 设置代理（示例）：

`ssh
Host github.com
  HostName github.com
  User git
  ProxyCommand nc -x 127.0.0.1:7890 %h %p
`

如果系统没有 
c，可先安装：

`ash
sudo apt update
sudo apt install -y netcat-openbsd
`
## 1.11 企业 CA 证书（可选，非官方补充）

如需信任公司代理/内网证书，可将 CA 证书加入系统信任（示例）：

`ash
sudo cp /mnt/c/Users/<you>/Downloads/company-ca.crt /usr/local/share/ca-certificates/
sudo update-ca-certificates
`

Node/npm 也可显式指定 CA：

`ash
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/company-ca.crt
npm config set cafile /usr/local/share/ca-certificates/company-ca.crt
`
## 2. 在 WSL 中安装 Node.js 与 Codex

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 22
npm i -g @openai/codex
codex
```

## 3. 在 WSL 中打开 VS Code

先确保已安装 VS Code 与 WSL 扩展。

```bash
cd ~/code/your-project
code .
```

确认右下角状态栏显示 `WSL: <distro>`，或执行：

```bash
echo $WSL_DISTRO_NAME
```

如果状态栏未显示 WSL，按 `Ctrl+Shift+P` 选择 `WSL: Reopen Folder in WSL`，并确保仓库位于 `/home/...`。

## 4. 项目目录建议

为了性能和权限稳定，建议把仓库放在 WSL 的 Linux 目录：

```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/your/repo.git
cd repo
```

需要从 Windows 访问时，可在资源管理器中打开：

```
\\wsl$\Ubuntu\home\<user>
```

## 5. 验证 Codex 是否可用

```bash
which codex || echo "codex not found"
```

## 6. 常见问题（官方建议）

- VS Code 扩展无响应：安装 C++ 构建工具和 VC++ 运行库后重启 VS Code。
- 大仓库卡顿：避免在 `/mnt/c` 下工作，把仓库移到 `~/code`，并更新 WSL：

```powershell
wsl --update
wsl --shutdown
```

- VS Code in WSL 找不到 `codex`：先执行 `which codex`，如未找到，按上面的安装步骤重新安装。

## 7. 同页非 WSL 内容（可选）

官方页面还包含 Windows 原生模式的 sandbox 说明（含 `config.toml` 配置与 `/sandbox-add-read-dir`），如你需要 Windows 原生使用 Codex，可单独补充该部分。

---

如需按你的实际需求定制（例如固定 Node 版本、公司内网镜像源），告诉我即可。







