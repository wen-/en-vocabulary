# HTTPS 预览

用于在本机和局域网里以 HTTPS 方式预览当前静态站点，方便在 iPhone Safari 中验证 Service Worker、离线缓存和“添加到主屏幕”。

如果当前机器没有管理员权限，优先使用下文的“无管理员权限方案”。它通过公网 HTTPS 隧道提供安全上下文，不依赖在本机或 iPhone 上安装证书。

## 无管理员权限方案

```bash
./scripts/start-public-preview.sh
```

默认会复用本地的 4180 端口；如果该端口没有服务，脚本会自动启动一个临时静态 HTTP 服务，并通过 localtunnel 暴露为公网 HTTPS 地址。

也可以指定其他本地端口：

```bash
./scripts/start-public-preview.sh 4181
```

适用场景：

- 无法执行 `mkcert -install`
- 无法给 iPhone 安装或信任本地根证书
- 只想尽快验证 iPhone Safari 上的 Service Worker、离线和“添加到主屏幕”

## 启动

```bash
./scripts/start-https-preview.sh
```

如果脚本输出证书未受信任，请先在 Mac 上执行：

```bash
mkcert -install
```

默认端口是 4443，也可以传入自定义端口：

```bash
./scripts/start-https-preview.sh 4444
```

## 证书策略

- 优先使用 mkcert 生成开发证书。
- 若本机没有 mkcert，则退回到 OpenSSL 自签名证书。
- 证书和私钥会写入项目根目录下的 .dev-https/。

## iPhone 验证

- Mac 本机浏览器可直接访问 https://127.0.0.1:4443。
- iPhone 请访问 Mac 的局域网地址，例如 https://192.168.x.x:4443。
- iPhone 若提示证书不受信任，需要先把 `$(mkcert -CAROOT)/rootCA.pem` 安装到手机，再到“设置 > 通用 > 关于本机 > 证书信任设置”里开启完全信任。
- 若使用 mkcert，想让 iPhone 也信任证书，需要把 mkcert 根证书安装到 iPhone 并在“设置 > 通用 > 关于本机 > 证书信任设置”中手动启用完全信任。
- 如果 iPhone 未信任该证书，页面仍可能打开，但 Service Worker 和完整 PWA 能力不一定可稳定验证。
- 如果你没有管理员权限，直接使用上面的 `start-public-preview.sh`，拿到公网 HTTPS 地址后在 iPhone 上访问即可。

## 快速检查

- 打开设置页中的“离线与安装状态”，确认“安全上下文已满足”。
- 首次打开后刷新一次，确认“离线内核已接管当前页面”。
- iPhone Safari 使用分享菜单中的“添加到主屏幕”完成安装验证。