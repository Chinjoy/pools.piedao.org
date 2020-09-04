import { erc20 } from "@pie-dao/abis";
import { ethers } from "ethers";
import { get } from "svelte/store";
import { isAddress, isPOJO, validateIsAddress } from "@pie-dao/utils";

import contractOverrides from "../../config/contractOverrides.json";

import { balanceKey, functionKey } from "./keys";
import { eth } from "./writables";
import { findAbi } from "./abi";
import { subject } from "./observables";

let contracts = {};

const trackedBalances = new Set();
const trackedFunctions = {};

let blockNumberPid = [0];

const updateOnBlock = () => {
  console.log('running balance update', Date.now());
  trackedBalances.forEach(async (key) => {
    const [token, account] = key.split(".");
    if (isAddress(token) && isAddress(account)) {
      const contract = (await observableContract({ abi: erc20, address: token })).raw;
      const balance = (await contract.balanceOf(account)).toString();
      subject(key).next(balance);
    } else {
      console.warn("Invalid key found in trackedBalances", key);
      console.warn("key should be formatted '[token address].[wallet address]'");
    }
  });

  Object.keys(trackedFunctions).forEach(async (key) => {
    const { contractAddress, rawFunction, args, overrides } = trackedFunctions[key];
    const contract = (await observableContract({ address: contractAddress })).raw;

    rawFunction
      .bind(contract)(...args, overrides)
      .then((...results) => {
        subject(key).next(...results);
      });
  });
};

subject("blockNumber").subscribe({
  next: (blockNumber) => {
    console.log('blockNumber', blockNumber);
    if (blockNumber > blockNumberPid[0] + 4) {
      clearTimeout(blockNumberPid[1]);
      blockNumberPid = [blockNumber, setTimeout(updateOnBlock, 500)];
    }
  },
});

subject("blockNumberBump").subscribe({
  next: (blockNumber) => {
    clearTimeout(blockNumberPid[1]);
    blockNumberPid = [blockNumber, setTimeout(updateOnBlock, 500)];
  },
});

const expectedArgLength = (functionName, contract) => {
  const { address } = contract;
  const definition = contract.interface.fragments.find(({ name }) => name === functionName);
  if (!definition) {
    throw new Error(
      `eth/contracts.js - function '${functionName}' not found in contract abi for ${address}`
    );
  }

  return definition.inputs.length;
};

const generateTrackBalanceFunction = (contractAddress) => {
  return async (account) => {
    validateIsAddress(account);
    const key = balanceKey(contractAddress, account);
    trackedBalances.add(key);
    const contract = await observableContract({ abi: erc20, address: contractAddress });
    contract.balanceOf(account).then((balance) => {
      subject(key).next(balance.toString());
    });
    return subject(key);
  };
};

const generateTrackableFunction = (contractAddress, functionName, rawFunction) => {
  return (...args) => {
    const contract = contracts[contractAddress].raw;
    const trackable = rawFunction.bind(contract)(...args);

    trackable.track = async (callerOverrides = {}) => {
      let overrides = callerOverrides;
      const key = functionKey(contractAddress, functionName, args, overrides);

      if (hasOverrides(functionName, contract)) {
        overrides = { ...getOverrides(functionName, contract), ...callerOverrides };
      }

      trackedFunctions[key] = {
        contractAddress,
        rawFunction,
        args,
        overrides,
      };
      rawFunction
        .bind(contract)(...args, overrides)
        .then((...results) => {
          subject(key).next(...results);
        });
      return subject(key);
    };

    return trackable;
  };
};

const getOverrides = (functionName, { address }) => {
  const addy = address.toLowerCase();
  return isPOJO(contractOverrides[addy]) ? contractOverrides[addy][functionName] : undefined;
};

const hasOverrides = (functionName, contract) => {
  const overrides = getOverrides(functionName, contract);
  return !!overrides;
};

const overrideWrapped = (prop, contract) => (...passedArgs) => {
  const args = [...passedArgs];
  const position = expectedArgLength(prop, contract);

  if (position < args.length) {
    throw new Error(
      `eth/contracts.js - function '${prop}' for contract ${address} ` +
      `called with too few arguments. Got ${args.length}. Expected ${position}.`
    );
  }

  if (isPOJO(args[position])) {
    args[position] = { ...getOverrides(prop, contract), ...args[position] };
  } else {
    args[position] = { ...getOverrides(prop, contract) };
  }

  return contract[prop](...args);
};

export const observableContract = async ({ abi, address }) => {
  validateIsAddress(address);

  if (contracts[address] && !abi) {
    return contracts[address];
  }

  let contractAbi = abi;

  if (!contractAbi) {
    try {
      contractAbi = await findAbi(address);
    } catch (e) {
      console.error(e);
      console.warn("Falling back on default erc20 abi for", address);
      contractAbi = erc20;
    }
  }

  const { provider, signer } = get(eth);
  let contract = new ethers.Contract(address, contractAbi, provider);

  if (signer) {
    contract = new ethers.Contract(address, contractAbi, signer);
  } else {
    contract = new ethers.Contract(address, contractAbi, provider);
  }

  const addons = {};

  addons.raw = contract;
  addons.trackBalance = generateTrackBalanceFunction(address);
  addons.functions = {};

  Object.keys(contract.functions).map((functionName) => {
    addons.functions[functionName] = generateTrackableFunction(
      address,
      functionName,
      contract.functions[functionName]
    );
  });

  const handler = {
    get: (obj, prop) => {
      if (Object.keys(addons).includes(prop)) {
        return addons[prop];
      } else if (contract[prop] && hasOverrides(prop, contract)) {
        return overrideWrapped(prop, contract);
      } else if (contract[prop]) {
        return contract[prop];
      }

      return obj[prop];
    },
  };

  const proxy = new Proxy({}, handler);

  if (!abi) {
    contracts[address] = proxy;
  }

  return proxy;
};

export const resetContractCache = () => {
  contracts = {};
};
