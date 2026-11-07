# 发布手册（GitHub + npm）

本文件记录一次真实的发布过程与踩坑，下次照这个顺序走，不要即兴发挥。

## 0. 发布前检查（每次都做）

```bash
# 包名是否被占用：404 = 可用，200 = 已被占
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/<name>

# 账号与 2FA 类型（决定后面走哪条路）
npm whoami
npm profile get | grep -i two-factor
```

**关键判断**：2FA 是 `auth-and-writes` 时，再看它是"验证器 App"还是"安全密钥（WebAuthn）"。
后者不产生 6 位数字，任何"请输入验证码"的思路都是死路。

## 1. GitHub（优先用 gh，不要点网页）

```bash
git init && git add -A && git commit -m "..."
gh repo create <name> --public --source=. --remote=origin --push
git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
```

- `gh auth status` 已登录时，全程不需要浏览器。
- 发布前跑一次个人信息扫描：路径、用户名、邮箱、令牌。

## 2. npm

### 情况 A：2FA 用验证器 App

```bash
npm publish --otp=<6位>
```

注意：码 30 秒过期，**不要让"人转述 → 再执行"这种链路**，直接在终端里输入。

### 情况 B：2FA 用安全密钥（WebAuthn）——本项目遇到的情况

命令行永远等不到验证码，走 Granular Token：

1. npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**
2. 权限选 **Read and write (publish and stage)**
3. **勾选 Bypass 2FA**
4. 包范围选 **All packages**（不选会报 "You must select at least one package or scope"）
5. 生成后立刻复制（只显示一次）

发布时用临时 npmrc，别把令牌写进项目：

```bash
printf '//registry.npmjs.org/:_authToken=<token>\n' > /tmp/npmrc-pub
chmod 600 /tmp/npmrc-pub
npm publish --userconfig /tmp/npmrc-pub --registry=https://registry.npmjs.org/
rm -f /tmp/npmrc-pub
```

发布后到 Access Tokens 撤销该令牌（7 天也会自动过期）。

### 新包首发会进审核

首次发布常常先出现一个 `0.0.0-stage` 占位版本，页面显示 "Temporary Holding Version"，
registry 过 1–3 分钟才出现真正的 0.2.0。**以 registry 为准**：

```bash
curl -s https://registry.npmjs.org/<name> | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags'])"
```

## 3. 发布后验证

```bash
npm view <name> version dist.tarball
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/<name>   # 200
```

## 4. 这次踩过的坑（别再犯）

| 坑 | 教训 |
| --- | --- |
| 包名 `dsh-browser-bridge` 已被占用 | 动手前先查 registry，别等改完文档才发现 |
| 让用户"输入 6 位验证码"三次 | 先读账号 2FA 类型；WebAuthn 账号根本没有 OTP |
| 在聊天里传令牌 | 令牌只经临时文件（600 权限），用完即删 |
| 用网页按钮删令牌 | 对自动化无响应，命令行 `npm token` 也可能卡住；优先手动点一次 |
| 网页显示 0.0.0-stage 以为失败 | 首次发布有审核窗口，看 registry 而不是页面 |
| 先改包名再发布 | 包名、README、install.mjs、依赖键要一次性同步改完 |
