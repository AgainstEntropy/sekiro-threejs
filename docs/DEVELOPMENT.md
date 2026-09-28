# 开发指南

## 环境与检查

使用 Node.js 24+。安装依赖执行 `npm ci`；`.nvmrc` 提供本地版本提示。

提交前运行 `npm run check` 与 `npm run build`。语法和打包检查不能代替实机玩法验证。GitHub Actions 会在 push 和 pull request 时执行这两项检查。

在浏览器中检查标题启动、移动与镜头、锁定、攻击、防御、弹反、架势条、暂停恢复，以及回生与忍杀。涉及音频的检查需要用户手势解锁 Web Audio。

## 模块沙盒

运行 `npm run dev` 后，可访问以下地址（沙盒仅用于开发，默认不打包进生产游戏）：

| 地址 | 内容 |
|---|---|
| `/sandbox/world.html` | 场景与光照 |
| `/sandbox/rig.html` | 角色、武器与骨骼 |
| `/sandbox/clips.html` | 动画片段 |
| `/sandbox/fx.html` | 特效 |
| `/sandbox/audio.html` | 合成音频 |
| `/sandbox/hud.html` | 界面 |

参数和按键提示在各沙盒页面内显示。

## 游戏调试参数

在游戏地址后添加查询参数，可组合使用，例如 `/?spawn=boss&nohints`。

| 参数 | 用途 |
|---|---|
| `autostart` | 跳过标题流程 |
| `spawn=start\|courtyard\|gate\|boss` | 指定出生点 |
| `god` | 调试无敌 |
| `noenemies` | 不生成敌人 |
| `freeze` | 冻结敌人行为 |
| `debug` | 调试输出 |
| `nohints` | 关闭首次提示 |
| `nopost` | 关闭后处理 |
| `fxscale=N` | 固定内部渲染比例 |
| `nodynres` | 关闭动态分辨率 |
| `msaa=0\|2\|4` | 抗锯齿采样档位 |

`window.__game` 与 `window.__ctx` 可用于开发诊断。普通演示建议不启用 `god` 或 `freeze`，以准确展示当前战斗表现。

## 构建与部署

`npm run build` 输出 `dist/`。使用 `npm run preview` 本地检查构建结果；不能直接双击 HTML 代替 HTTP 服务。

Vite 默认面向站点根路径。如果放到 GitHub Pages 等子目录，请使用对应 base，例如：

```bash
npm run build -- --base=/sekiro-threejs/
```

这只生成构建产物，不会自动发布网站。

## 发布整理范围

此次发布保留原有游戏机制与常规 WASD 按住移动操作。临时拍摄副本的移动切换、HUD 录制和媒体上传端点不包含在本仓库内。历史一次性自动化、截图与压力测试脚本仍保留在原始开发项目，不作为本仓库支持的工具接口。
