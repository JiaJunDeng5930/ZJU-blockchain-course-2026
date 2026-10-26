# TwoPool DEX 前端

运行、钱包配置、模拟交易和截图说明见[项目 README](../README.md)。

```bash
npm ci
npm run dev
```

先运行本地链和部署；Vite 从 `../shared/` 读取实际部署配置。生产构建也会复制该配置，因此换链或重新部署后应重新构建。

```bash
npm run build
npx playwright install chromium
npm test
```

浏览器端到端测试通过真实 RPC 执行交易，要求本地节点已部署、前端已在 3000 端口运行。测试会改变链状态、创建测试代币，并生成 `docs/screenshots/` 中的截图。不要同时运行模拟脚本。

前端使用合约编译生成的 TypeChain 类型，因此需先在 `contracts/` 完成编译和部署。钱包会话响应账户、网络和断开事件；交易日志与链上读取分别处理。运行 `npm test` 会执行完整业务流程及钱包故障恢复的七个黑盒场景。
