# TwoPool DEX：AMM、NFT 流动性凭证与原子套利

基于本地以太坊链的课程项目。用户创建代币和交易池、兑换资产；流动性提供者通过 ERC721 NFT 持有和赎回份额；20 个模拟账户在 Harbor、Summit 两家交易所形成价差，由套利合约在一笔交易中完成买卖和利润检查。

## 启动本地交易所

使用 Node.js 24、26+ 或 22.13+（22.x）和 npm。首次在仓库根目录执行：

```bash
npm run setup
CHOKIDAR_USEPOLLING=true npm run dev
```

打开终端给出的地址，默认是 [http://127.0.0.1:3000](http://127.0.0.1:3000)。启动器完成合约编译、本地部署和服务启动；以后只需最后一行。默认链 ID 为 `31337`，RPC 为 `http://127.0.0.1:8545`。

部署包含 TKA、TKB、WETH、两个各有 10000 TKA / 10000 TKB 的初始池，以及 20 个已准备测试资产的账户。`Ctrl+C` 停服务；由启动器新建的内存链随之消失。需要单独保持节点运行或执行浏览器验收时，见[前端说明](frontend/README.md)。

## 完成一次建池、交易和赎回

1. 右上角选 **Demo wallet → Account 1**。在 **Tools → Pools & tokens** 创建测试代币，再回钱包领取新币；钱包也可领取测试 ETH。使用扩展钱包时按[连接指南](docs/wallet-guide.md)准备本地网络和资产。
2. 选交易所及两种代币创建空池，点 **Add liquidity to this pool** 首次注资，获得 NFT。**Liquidity → Manage** 查看份额、创建时间和赎回报价；**Explore a pool → Pool information** 查看该池的流动性来源。
3. 切到 **Account 2**，在 **Swap → Active pool** 选择新池，输入金额，经 **Review swap → Confirm swap** 完成兑换，读取实际到账。
4. 切回 **Account 1**，在新 NFT 的 **Manage** 中点 **Burn NFT… & redeem**，核对最低收到数量后确认，取回资产和份额中的手续费。

<details>
<summary>查看钱包、建池、NFT、交易和赎回截图</summary>

![钱包与测试资产](docs/screenshots/01-wallet-assets.jpg)
![创建 ERC20 的链上结果](docs/screenshots/02-token-created.jpg)
![创建空池并进入首次注资](docs/screenshots/03-pool-created.jpg)
![注资获得 NFT](docs/screenshots/04-liquidity-nft.jpg)
![池的流动性来源](docs/screenshots/05-liquidity-sources.jpg)
![兑换的实际到账与回执](docs/screenshots/06-swap-confirmed.jpg)
![销毁 NFT 后的实际赎回](docs/screenshots/07-liquidity-redeemed.jpg)

</details>

## 验证多用户运行和原子套利

打开 **Tools → Simulation**，设置最少轮数、最短运行时间、间隔和种子，点 **Start simulation**。20 个地址执行随机兑换、添加/撤销流动性和自动套利；每笔操作等待真实回执。结束后展示参与地址、操作统计、成功套利的本金与利润、两池 Before/After，以及真实失败交易的回滚检查。要修改已完成一轮的参数，展开 **Run settings**。

2026-11-06 的一次独立运行使用种子 `20261106`、最少 20 轮、最短 60 秒、间隔 150 ms：**20 个地址持续运行 63.077 秒、150 轮，取得 265 笔回执和 12 次盈利套利**。其中兑换 87 次、添加和撤销各 44 次；总代币利润为 45.490483964136775863 TKA。真实失败套利的收据状态为 `0`，两池储备和代币余额均未改变。

![20 个用户的持续运行结果](docs/screenshots/08-simulation-completed.jpg)

<details>
<summary>查看一笔成功套利的数量与价格变化</summary>

该笔交易以 500 TKA 为本金，实际利润为 44.326295632524166828 TKA；两图的 Before/After 对应同一笔执行。

![套利本金、利润和两池储备](docs/screenshots/09-arbitrage-result.jpg)
![同一笔交易的另一储备列与价格](docs/screenshots/10-arbitrage-prices.jpg)

</details>

也可在 **Tools → Arbitrage** 手动输入本金并查找路线，核对正利润后执行。报告由 **Run details and exports** 下载；运行期间不要同时手动交易。上述数字来自实拍示例，收益随链状态和操作顺序变化。

## 这些操作如何实现

交易采用恒定乘积和 0.3% 输入手续费。输入储备为 `x`、输出储备为 `y`、输入量为 `a` 时：

```text
amountOut = floor(997 × a × y / (1000 × x + 997 × a))
```

完整输入进入储备，手续费留在池中。NFT 记录池和份额，赎回按 `floor(positionShares × reserve / totalShares)` 取回两种资产；首次总份额为 `floor(sqrt(amount0 × amount1))`，其中 1000 份永久锁定。赎回值也受价格变化影响，不能把它与初始存入的差额直接视为手续费收益。转让 NFT 会转移赎回权。

Harbor 与 Summit 为独立合约。原子套利使用调用者本金，在低价池买入、高价池卖出，最后检查最低利润；任一步失败则整笔回滚。代币利润计入池手续费，ETH gas 另列。A/ETH 市场先将 ETH 按 1:1 包装为 WETH，再使用同一套 ERC20 建池流程。支持普通、无转账税且不 rebasing 的 ERC20。

## 验证与进一步阅读

Solidity 实现链上合约；Rocq 定义共享规格和前端业务决策，经 **Extraction → OCaml → js_of_ocaml** 生成 JavaScript。React 渲染结果，viem 执行钱包与 RPC 效应。

```bash
npm test
npm run formal:verify
```

局部算术、状态和 helper 的证明不等于完整 Solidity/EVM 正确性证明。可复现命令、已证明范围及可信边界见[形式化说明](formal/README.md)；金额、钱包、NFT、模拟等公开入口验收见[验收命令](frontend/acceptance/README.md)。验收使用隔离链，不重置演示链。

## 参考资料

- [Uniswap V2 流动性](https://developers.uniswap.org/docs/protocols/v2/guides/providing-liquidity)、[交易集成](https://developers.uniswap.org/docs/protocols/v2/guides/swapping)、[Pair 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [OpenZeppelin ERC20](https://docs.openzeppelin.com/contracts/5.x/erc20)、[ERC721](https://docs.openzeppelin.com/contracts/5.x/erc721)
- [Solidity SMTChecker](https://docs.soliditylang.org/en/latest/smtchecker.html)、[rocq-of-solidity](https://github.com/formal-land/rocq-of-solidity)、[Rocq](https://rocq-prover.org/)
