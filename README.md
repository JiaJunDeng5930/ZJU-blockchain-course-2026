# TwoPool DEX：AMM、NFT 流动性凭证与原子套利

基于以太坊本地链的去中心化交易所课程项目。用户可以领取或创建 ERC20 测试代币、创建交易池、交易、添加流动性并获得 ERC721 NFT，最后销毁 NFT 赎回资产。两个独立交易所 Harbor 和 Summit 为相同代币提供不同的池子；模拟器让 20 个地址持续交易，套利合约在一笔交易中完成两次交换并检查利润。

## 环境与运行

需要 **Node.js 22.13+（22.x）、24.x 或 26+** 和 npm。建议使用 Node.js 24。本项目实际验收使用 Node.js 26.5.0。浏览器无需钱包扩展即可通过本地节点的测试账户操作；也支持 MetaMask 等 EIP-1193 浏览器钱包。

在仓库根目录安装依赖：

```bash
npm --prefix contracts ci
npm --prefix frontend ci
```

终端一，启动本地区块链，保持运行：

```bash
cd contracts
npm run node
```

终端二，部署合约并导出前端所需的地址、ABI、测试代币字节码：

```bash
cd contracts
npm run deploy
```

部署自动创建 TKA、TKB、WETH、Harbor、Summit 和 AtomicArbitrage；为节点提供的 20 个账户分别领取 TKA/TKB，并创建两个 10000 TKA / 10000 TKB 的初始池。Hardhat 已为这些账户提供测试 ETH。部署者持有两个初始流动性 NFT。

终端三，启动前端：

```bash
cd frontend
npm run dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。默认连接本地 RPC 的第一个账户，可从顶部下拉框切换 20 个账户。链 ID 为 `31337`，RPC 为 `http://127.0.0.1:8545`。不要把这些公开测试账户用于真实资产。

`shared/deployment.json` 根据实际部署生成，不提交仓库。重新启动节点会清空链状态，必须重新部署并刷新网页。部署可重复执行，但会部署一套新合约并覆盖该文件；先前合约仍在当前链中。

### 使用浏览器钱包

1. 在钱包中添加本地网络：RPC `http://127.0.0.1:8545`，链 ID `31337`，原生币 `ETH`。
2. 点击 **Connect browser wallet** 并批准连接。
3. 点击 **Claim 10 local ETH**，本地节点的开发账户会向当前钱包转入 10 ETH，供支付 gas。
4. 点击 **Claim 10,000 TKA / TKB**，按钱包提示确认领取。
5. 交易或提供流动性时，先批准 ERC20 allowance，再确认实际操作。钱包账户变化会自动更新当前身份；切到错误网络时禁用提交并提示，切回后恢复。前端在每次签名前再次核对账户和网络。

这里的 ETH 领取使用开发节点的解锁账户，仅适用于本地演示。验收截图使用本地 RPC 账户签名；浏览器扩展钱包需要用户自行批准弹窗。

## 操作流程

- **Swap**：选择交易所和池、输入方向和数量，查看包含手续费的报价，设置滑点后点击 **Approve & swap**。
- **Liquidity**：输入两种代币的最大投入量，点击 **Approve & mint position NFT**。已有池按当前储备比例投入，未使用部分留在钱包；新池由首次提供者设定初始比例。
- **My positions**：查看 NFT 编号、池信息、初始投入、份额、创建时间、当前赎回估值以及链上 JSON 元数据。点击 **Burn NFT & redeem** 销毁整个头寸，赎回储备和手续费收益。NFT 转让后由新持有者享有赎回权。
- **Liquidity sources**：查看当前池所有未赎回头寸及其当前所有者。
- **Pools & tokens**：在指定交易所建池；可部署自定义名称/符号的测试 ERC20，也可导入已有的 18 位精度标准 ERC20 地址。新建测试代币可从余额卡片领取。支持 ETH/WETH 包装与解包，用 WETH 建立代币/ETH 对应的交易池。
- **Arbitrage**：选定池后点击 **Find profitable route**，选择本金代币，扫描两个方向、1/5/10/25/50/100/200/500 的输入量，并按同一本金币种的利润排序。存在机会时展示本金和预期利润；设置最低利润后一次提交原子套利。结果显示实际利润及两池储备和价格的前后变化。
- **Transactions**：显示当前浏览器会话中的交易哈希、区块、操作和 gas 成本，批准与执行分别记录。

自定义代币列表按部署地址保存在当前浏览器中，刷新后继续可用。链上的代币、池和 NFT 数据由合约维护。

## 功能与实现分析

### AMM 定价和手续费

每个 MiniDEX 维护多个按地址排序的代币对，同一交易所禁止重复建同一代币对。输入数量为 `dx`，输入储备为 `x`、输出储备为 `y` 时：

```text
amountInWithFee = dx × 9970
amountOut = floor(amountInWithFee × y / (x × 10000 + amountInWithFee))
```

交易收取 0.3% 手续费，全部留在池中，不单独建立奖励账户；流动性提供者通过份额共享增加的储备。价格显示为储备比，实际成交还受手续费和价格冲击影响。

### ERC721 流动性与分红

首次加入的份额基于 `sqrt(amount0 × amount1)`；其中 1000 个最小份额永久锁定，以免池子被完全清空后通过重新初始化影响份额会计。后续按储备比例计算份额。每次添加流动性铸造一个独立 NFT，记录池 ID、份额、初始投入与时间戳；`tokenURI` 返回自包含的 Base64 JSON。

```text
redeem0 = floor(positionShares × reserve0 / totalShares)
redeem1 = floor(positionShares × reserve1 / totalShares)
```

赎回烧毁整个 NFT。手续费已反映在当前储备中，无需另行领取。ERC721 所有者或被授权的操作者可赎回，但资产始终转给当前所有者。NFT 不保证原始两种代币数量：价格变化可能带来无常损失。

### Bonus：双交易所与原子套利

Harbor 和 Summit 是两个独立部署的交易所，具有独立储备。模拟器在两个市场分别执行随机交易，产生价格差，再自动寻找扣除两次交易手续费后的有利路径。

`AtomicArbitrage.execute` 从调用者领取本金，执行 `本金代币 → 中间代币 → 本金代币`，要求最终收回数量大于本金且利润达到 `minProfit`。任何一步失败或利润不足，EVM 回滚整笔交易，包括两池储备、ERC20 余额及该笔交易内的 allowance 变化。提交前单独执行的 approve 不属于套利交易，不会随它回滚；失败交易仍消耗 gas。

这是**自有本金套利**，不使用闪电贷。报价和利润以本金代币计价，**未扣 ETH gas 成本**，不代表法币净利润。界面和模拟器仅扫描有限输入量，不声称找到数学上的最优套利量。合约只支持两交易所之间相同代币对的两跳路径。

### 输入和资产边界

使用 OpenZeppelin 的 ERC20、ERC721、SafeERC20、ReentrancyGuard 和 Math。交易、增减流动性都有期限与最小收到数量检查。代币必须是标准、不重定基准且不收转账税的 ERC20；合约拒绝收到金额不足的入账。前端仅支持 18 位精度代币。测试 faucet 无限制发币，适用于教学链。

有关选择这些边界的原因见 [ADR 001](docs/adr/001-amm-liquidity-and-local-demo.md)。前端直接使用合约编译生成的 TypeChain 工厂和类型，公开接口以 [Solidity 合约](contracts/contracts/MiniDEX.sol) 为准。

## 20 地址持续模拟与结果

保持节点运行并完成部署后执行：

```bash
cd contracts
npm run simulate
```

默认使用 20 个地址、60 轮、固定种子 2026。每个地址都会参与交易和流动性操作；随机阶段在两个交易所操作，并自动检测套利。每笔操作等待链上收据，报告包括交易哈希、成功次数、参与地址、套利前后价格/储备/利润，以及一次实际失败套利的回滚证明。

延长至至少 2 分钟的演示：

```bash
SIM_ROUNDS=120 SIM_DURATION_SECONDS=120 SIM_INTERVAL_MS=300 npm run simulate
```

`SIM_ROUNDS` 至少 20；`SIM_SEED` 指定随机种子；`SIM_DURATION_SECONDS` 指定最短运行时间；`SIM_INTERVAL_MS` 控制操作间隔。节点区块时间会影响部分时间戳，但同一初始状态和种子决定操作选择。复现实验时不要在前端同时提交交易，以免报价竞争；行情变化引起的拒绝属于真实失败，不算成功。

另一次连续运行持续 **123.072 秒**，实际执行 **231 轮**，20 个地址参与，完成 113 次交易、75 次添加、75 次撤销流动性及 16 次盈利套利。记录的 302 笔交易中有 301 笔成功、1 笔预期失败；失败交易的储备和余额回滚检查通过。

完整运行报告位于 `shared/simulation-report.json`，不提交仓库。前端 Arbitrage 页的 **Load simulation report** 可读取并展示该报告。

本次真实本地链验收运行 60 轮，耗时约 15.6 秒：20 个活跃地址，32 次交易、24 次添加流动性、24 次撤销流动性、7 次盈利原子套利，记录 88 笔交易（含批准和一笔预期失败交易）。这是运行现场快照，运行前已有试跑交易，重新部署后具体价格和收益会不同。

一个可核对的套利实例：投入 500 TKA，经 Summit → Harbor 返回约 545.49436182 TKA，利润约 **45.49436182 TKA**，未扣 gas。Harbor 的 TKB/TKA 储备价格由 0.6579700664 变为 0.7202823420，Summit 由 0.7889808589 变为 0.7234178470。交易哈希：

```text
0x3c9c406af5ffb385f29f4036b085753c5fd4bcb6b8511c4150c1a2a39ff2d12a
```

最低利润条件不满足的实际失败交易 `0x590ab3f7fcabbed35bbb54ab3351b8026203ee74a096eee76337f8d3f185c3b7` 的收据为 `status=0`。脚本比较交易前后数据，确认两池储备、调用者和套利合约的代币余额均完整回滚。上述哈希只属于本次本地链，不能通过公共区块浏览器查询。

## 验证

合约端到端测试通过公开合约部署和交易入口验证工程目标；测试作者未读取具体合约实现。

```bash
cd contracts
npm run typecheck
npm test
```

5 个场景覆盖：领取 ERC20、包装 ETH 和创建唯一池；NFT 元数据、比例投入与转让后赎回；手续费、滑点和期限；20 地址领取/交易/增减流动性；成功原子套利及失败后的储备/余额/allowance 回滚。

前端以 React 功能页面组织表单，链访问集中在 `frontend/src/chain/client.ts`，使用生成的合约类型而非动态 `any` 调用。钱包会话将地址和 signer 绑定，响应 EIP-1193 事件；TanStack Query 管理链上快照和报价。交易日志分别记录等待签名、已提交、已确认和失败，读取失败不会覆盖已经确认的结果。选择这些边界的原因见 [ADR 002](docs/adr/002-frontend-wallet-and-transactions.md)。

前端构建与真实浏览器流程：

```bash
cd frontend
npm run build
npx playwright install chromium
# 保持本地节点、部署与 npm run dev 在运行
npm test
```

7 个浏览器端到端场景通过：完整流程执行领取、交易、增减流动性、创建 ERC20、建池、WETH 包装/解包和界面套利；另外验证无效金额不签名、账户事件与真实交易身份一致、错误网络阻断和恢复、拒绝交换后保留批准并可重试、批准期间切换账户时阻止旧 signer、确认后读取失败仍保留成功记录。钱包事件与拒绝签名测试使用 EIP-1193 适配器连接真实本地 RPC，未使用真实钱包扩展。测试会改变当前链状态并更新截图；请勿与模拟器并发执行。验收覆盖本地链，不包含公共测试网或生产部署。

## 项目运行截图

以下截图来自真实本地链与浏览器操作，包含当前账户、链 ID、余额、链上交易确认、NFT 信息和套利结果。

### 领取与交易

![账户、储备和交易确认](docs/screenshots/01-swap.png)

### NFT 流动性与来源

![NFT份额、创建时间、赎回估值和池的流动性来源](docs/screenshots/02-liquidity.png)

### 代币创建、建池与 WETH

![双交易所池、代币部署、建池与ETH包装](docs/screenshots/03-pools.png)

### 原子套利结果

![实际利润和两池价格、储备前后变化](docs/screenshots/04-arbitrage.png)

### 区块链交互记录

![批准、执行、交易哈希、区块与gas](docs/screenshots/05-transactions.png)

## 参考资料

- [Uniswap 官方：AMM 与参与方](https://developers.uniswap.org/docs/get-started/concepts/how-uniswap-works)
- [Uniswap 官方：V2/V3/V4 手续费](https://developers.uniswap.org/docs/get-started/concepts/fees)
- [Uniswap V2 Pair 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [OpenZeppelin ERC20](https://docs.openzeppelin.com/contracts/5.x/erc20)、[ERC721](https://docs.openzeppelin.com/contracts/5.x/erc721)
- [Hardhat 文档](https://hardhat.org/docs)、[ethers v6 文档](https://docs.ethers.org/v6/)
- [课程参考 Demo](https://github.com/LBruyne/blockchain-course-demos)

本项目借鉴 Uniswap V2 的恒定乘积与份额机制，用 ERC721 替代可互换的 LP Token，未复制 Uniswap V2 的工厂、路由与闪电交换体系。
