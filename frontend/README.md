# TwoPool DEX 前端

启动、操作流程、Bonus 结果和关键截图见[项目 README](../README.md)。先在仓库根目录安装依赖、引导形式化工具链并构建，再保持本地链、部署和模拟服务可用。

```bash
# 在仓库根目录执行
npm run setup
npm run formal:bootstrap
npm run build
npm run dev
```

前端使用实际部署生成的 ABI 和配置，以及从 Rocq 提取的业务内核。换链或重新部署后应重新生成构建产物。

## 浏览器验收

保持网页在 3000 端口、本地链在部署配置中的 RPC 端口运行，然后执行：

```bash
cd frontend
npx playwright install chromium
npm test
```

浏览器验收通过真实 RPC 执行课程流程和钱包交互，会改变本地测试链状态；运行时不要同时启动模拟。截图保存在忽略的 `frontend/test-results/`，不会覆盖 README 的精选图片。

链上公开入口与提取内核的验收命令见[验收说明](acceptance/README.md)。交易活动保留当前页面记录，刷新只恢复同一标签页已知待确认交易的观察。钱包偏好与交易状态分别保存。
