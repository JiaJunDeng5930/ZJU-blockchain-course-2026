# MiniDEX 合约工程

使用 Hardhat 3、ethers 6 和 OpenZeppelin 5.4，Solidity 0.8.20。测试网络默认提供 20 个已解锁且预充值 ETH 的账户。

## 运行

建议 Node.js 24 或项目 `package.json` 指定的兼容版本。在本目录执行：

```bash
npm ci
npm run compile
npm run typecheck
npm test
npm run node
```

保持节点运行，在另一终端执行：

```bash
npm run deploy
```

部署创建两种测试 ERC20、WETH、两个独立交易所和套利合约。每个测试地址通过公开 faucet 领取代币；两个交易所各建立一个初始 10000 TKA / 10000 TKB 的池。地址、ABI 和创建测试代币所需字节码导出到 `../shared/deployment.json`，供前端和模拟脚本共享。部署者拥有两个初始流动性 NFT。

默认 RPC 为 `http://127.0.0.1:8545`，Chain ID 为 `31337`。可设置 `LOCAL_RPC_URL`。本地账户由节点签名，仅用于本地教学链。重新启动节点后应重新部署；地址文件本身不代表链上仍有合约。

## 合约入口

- `TestToken.faucet()`：每次给调用者发放 10000 代币，无权限限制，仅用于测试。
- `WrappedEther.deposit/withdraw`：ETH 与 WETH 按 1:1 兑换，交易池统一处理 ERC20。
- `MiniDEX.createPool`：按代币地址排序，一个交易所内每种代币对只允许一个池。
- `MiniDEX.addLiquidity/removeLiquidity`：按池中比例注入、以 ERC721 NFT 记录份额；销毁 NFT 按当前储备赎回。NFT 转让也转让赎回权，获授权的操作员赎回时资产仍发给当前所有者。
- `MiniDEX.quote/swap`：恒定乘积兑换，收取 0.3% 手续费并留在池中，由份额共同享有。
- `AtomicArbitrage.execute`：调用者先授权本金，一笔交易完成两个池的往返兑换；利润不足则全部回滚。利润以本金代币计，不扣除 ETH Gas。

所有金额均为 ERC20 原始整数，演示代币精度为 18。流动性与交易操作支持截止时间和最低接收金额。初始 1000 个原始份额单位永久锁定，防止池完全清空后重置。流动性 NFT 的 `tokenURI` 是自包含 JSON，记录池、份额、初始金额、时间及代币地址。

支持普通、无转账税、非 rebasing 的 ERC20；收款不足会回滚。直接向交易所转账不会增加池储备，也不会自动铸造流动性份额。

## 验证

`npm test` 通过公开合约入口执行完整链上流程，覆盖兑换、流动性份额、NFT 转让赎回、WETH、多账户和套利失败回滚。`npm run simulate` 在已部署的本地节点上执行可复现模拟；详见仓库根 README。

Ganache 也可以运行 `npm run deploy:ganache`，需要至少 20 个已解锁账户，RPC 用 `GANACHE_RPC_URL` 指定；合约目标 EVM 为 Paris。
