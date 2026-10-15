# 同事测试版发布

- 私密仓库：https://github.com/zerOne4yyt/hunan-terrain-ar-demo
- 测试地址：https://hunan-terrain-ar-preview.yytsky1.workers.dev/
- 本轮截止：2026-10-08 18:52:23（北京时间），即 `2026-10-08T10:52:23Z`。
- 已核验：线上首页与高程资源返回 200，截止响应头正确，私有说明文档地址返回 404；到期拦截测试通过。Cloudflare 版本：`884f187c-71b4-49da-b84e-f56a0e7877ed`。

## 本地运行与备份

本仓库包含当前 Web Demo、生成素材、历史视觉方案和 `source-data/dem/` 高程源数据。网页运行只需已生成的 `assets/`，不需要重新运行 Python 转换。重新生成时执行 `python3 build_assets.py`，依赖 NumPy 与 Pillow。Three.js 模块已随项目保存。

## Cloudflare 发布

```bash
node scripts/build-preview.mjs
node --test deploy/worker.test.mjs
npx --yes wrangler@4.142.0 whoami
npx --yes wrangler@4.142.0 deploy
```

`dist/` 由白名单构建，仅包含网页运行素材。源码研究说明、原始 DEM、历史截图、版本备份、Git 元数据不会作为网站文件发布。

## 10 天到期规则

截止时间固定记录在 `wrangler.json` 的 `PREVIEW_EXPIRES_AT`，使用 UTC。重新部署不会自动延长有效期。

所有请求都先执行 Worker（`assets.run_worker_first: true`），由服务器时间判断是否到期。截止后首页与所有直接素材地址均返回 HTTP 410；截止前也使用 `Cache-Control: no-store`，避免浏览器持久缓存绕过后续访问检查。此机制自动关闭测试访问，不删除 GitHub 私密仓库，也不删除 Cloudflare 项目配置及已上传资产。已经打开并载入内存的画面或他人已保存的副本不受远程撤回控制。

链接用于同事持链接测试，未设置登录鉴权；私密的是 GitHub 仓库。摄像头仅本地预览，不录制、不上传，HTTPS 下由访问者授权。

到期后如果需要新一轮测试，由项目负责人明确修改截止时间并重新发布。不要为了日常修复自动重置截止时间。

技术依据：[Cloudflare Worker-first 静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)。
