# TwoPool DEX 前端

首次安装、常规启动和课程演示见[项目 README](../README.md)。这里说明如何独立保留节点和运行浏览器验收。

## 重启网页时保留链状态

常规 `npm run dev` 会管理本次创建的服务。要独立保持内存链运行，先在仓库根目录构建：

```bash
npm run build
```

以下三个终端都从仓库根目录开始。先等终端 1 的节点就绪，再运行终端 2；部署完成后启动终端 3。

| 终端 | 命令 |
| --- | --- |
| 1：保持节点运行 | `npm --prefix contracts run node` |
| 2：部署并保持模拟服务运行 | `npm --prefix contracts run deploy && npm --prefix contracts run simulation:server` |
| 3：启动网页 | `CHOKIDAR_USEPOLLING=true npm --prefix frontend run dev` |

节点不退出，重启网页不会丢失资产。

## 在真实网页上验收

保持网页在 3000 端口、节点和模拟服务运行，再执行：

```bash
cd frontend
npx playwright install chromium
npm test
```

浏览器验收会改变演示链状态，运行时停止模拟。截图写入忽略的 `frontend/test-results/`。需要独立链上的钱包/SDK 验收时，选择[公开入口命令](acceptance/README.md)。
