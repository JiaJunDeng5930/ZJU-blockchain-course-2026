// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICallbackWrappedEther {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// Contract holders exercise the public WETH interface without inheriting it.
contract WrappingCallbackActor {
    ICallbackWrappedEther public immutable wrapped;
    uint256 public received;
    uint256 public callbacks;
    uint256 public nestedAttempts;
    bool public nestedSucceeded;
    uint256 public nestedAmount;
    uint8 public mode;
    bool private attempted;

    constructor(address wrapped_) {
        wrapped = ICallbackWrappedEther(wrapped_);
    }

    function fund() external payable {
        wrapped.deposit{value: msg.value}();
    }

    function configure(uint8 mode_, uint256 nestedAmount_) external {
        mode = mode_;
        nestedAmount = nestedAmount_;
        attempted = false;
    }

    function redeem(uint256 amount) external {
        wrapped.withdraw(amount);
    }

    receive() external payable {
        callbacks += 1;
        received += msg.value;
        if (mode == 1) revert("fixture refuses ETH");
        if (mode == 2 && !attempted) {
            attempted = true;
            nestedAttempts += 1;
            (nestedSucceeded,) = address(wrapped).call(
                abi.encodeCall(ICallbackWrappedEther.withdraw, (nestedAmount))
            );
        }
    }
}
