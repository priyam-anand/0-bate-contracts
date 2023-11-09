import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { algos, getOrCreateKmdWalletAccount } from '@algorandfoundation/algokit-utils';
import algosdk, { Algodv2, AtomicTransactionComposer, bigIntToBytes, makeApplicationOptInTxnFromObject } from 'algosdk';
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import path from 'path';
import { WillexecClient } from '../contracts/clients/WillexecClient';

const fixture = algorandFixture();

let appClient: WillexecClient;
let sender: algosdk.Account;
let receiver1: algosdk.Account;
let receiver2: algosdk.Account;
let assetIndex: number;
const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 8192;

const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/artifacts/Willexec.abi.json'), 'utf8'));
const contract = new algosdk.ABIContract(abi);
let algod: Algodv2;

describe('Willexec', () => {
  beforeEach(fixture.beforeEach);

  const initalizeAccounts = async (kmd: algosdk.Kmd) => {
    [receiver1, receiver2, sender] = await Promise.all([
      getOrCreateKmdWalletAccount(
        {
          name: 'receiver1',
          fundWith: algos(10),
        },
        algod,
        kmd
      ),
      getOrCreateKmdWalletAccount(
        {
          name: 'receiver2',
          fundWith: algos(10),
        },
        algod,
        kmd
      ),
      getOrCreateKmdWalletAccount(
        {
          name: 'currentSender2',
          fundWith: algos(10000),
        },
        algod,
        kmd
      ),
    ]);
  };

  const initalizeAssets = async () => {
    const suggestedParams = await algokit.getTransactionParams(undefined, algod);
    const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: sender.addr,
      suggestedParams,
      defaultFrozen: false,
      unitName: 'one',
      assetName: 'One for All',
      total: 100000,
      decimals: 0,
    });
    const signedTx1 = txn.signTxn(sender.sk);
    await algod.sendRawTransaction(signedTx1).do();
    const assetResult = await algosdk.waitForConfirmation(algod, txn.txID().toString(), 3);
    return assetResult['asset-index'];
  };

  const optIn = async (_assetIndex: number) => {
    await appClient.appClient.fundAppAccount(algokit.microAlgos(100000));
    await appClient.assetOptIn(
      { asset: _assetIndex },
      {
        sendParams: {
          fee: algokit.microAlgos(2000), // fee for itxn
        },
      }
    );
  };

  const getTimeStamp = async () => {
    const status = await algod.status().do();
    const latestBlock = status['last-round'];
    const blockInfo = await algod.block(latestBlock).do();
    return BigInt(blockInfo.block.ts as number);
  };

  beforeAll(async () => {
    await fixture.beforeEach();
    const { testAccount, kmd } = fixture.context;
    algod = fixture.context.algod;
    appClient = new WillexecClient(
      {
        sender: testAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );
    await initalizeAccounts(kmd);
    await appClient.create.createApplication({});
    assetIndex = await initalizeAssets();
  });

  test('createWill ', async () => {
    const from = sender.addr;

    // set mbr for boxes
    await appClient.appClient.fundAppAccount(algokit.microAlgos(100000));

    // format receiver addresses
    const topk1 = algosdk.decodeAddress(receiver1.addr);
    const topk2 = algosdk.decodeAddress(receiver2.addr);
    const toToPass = [...topk1.publicKey].concat([...topk2.publicKey]) as unknown as Uint8Array;

    // format amount of native tokens
    const amount1 = bigIntToBytes(123321, 8);
    const amount2 = bigIntToBytes(1111, 8);
    const amountsToPass = [...amount1].concat([...amount2]) as unknown as Uint8Array;

    // foramt amount of assets
    const assetAmount1 = bigIntToBytes(100, 8);
    const assetAmountToPass = assetAmount1;

    // format assets
    const asset1 = bigIntToBytes(assetIndex, 8);
    const assetsToPass = asset1;

    // opt in the asset
    await optIn(assetIndex);

    const totalCost =
      COST_PER_BOX + // cost of box
      MAX_BOX_SIZE * COST_PER_BYTE + // cost of data
      64 * COST_PER_BYTE + // cost of key
      64 * COST_PER_BYTE + // cost of key
      123321 +
      1111;

    // create transactions
    const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      from: sender.addr,
      to: (await appClient.appClient.getAppReference()).appAddress,
      amount: algokit.microAlgos(totalCost).valueOf(),
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
    });
    const assetTransferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: sender.addr,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      to: (await appClient.appClient.getAppReference()).appAddress,
      assetIndex,
      amount: 100,
    });
    const senderSIgner = algosdk.makeBasicAccountTransactionSigner(sender);

    const atc = new AtomicTransactionComposer();
    const boxes: algosdk.BoxReference[] = new Array(8).fill({
      appIndex: Number((await appClient.appClient.getAppReference()).appId),
      name: bigIntToBytes(1, 8),
    });

    // get timestamp for params
    const timestamp = await getTimeStamp();

    // build txn
    atc.addTransaction({ txn: payTxn, signer: senderSIgner });
    atc.addTransaction({ txn: assetTransferTxn, signer: senderSIgner });
    atc.addMethodCall({
      appID: (await appClient.appClient.getAppReference()).appId as number,
      method: contract.getMethodByName('createWill'),
      methodArgs: [
        from,
        assetsToPass,
        assetAmountToPass,
        topk1.publicKey,
        amountsToPass,
        toToPass,
        timestamp + BigInt(1),
      ],
      sender: sender.addr,
      signer: senderSIgner,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      boxes,
    });

    await atc.execute(algod, 4);

    const assetResult = await algod
      .accountAssetInformation((await appClient.appClient.getAppReference()).appAddress, assetIndex)
      .do();
    const algoResult = await algod.accountInformation((await appClient.appClient.getAppReference()).appAddress).do();

    expect(assetResult['asset-holding'].amount === 100);
    expect(algoResult.amount - algoResult['min-balance'] === 3370832);
  });

  test('execute will ', async () => {
    const timestamp = await getTimeStamp();
    await algod.setBlockOffsetTimestamp(Number(timestamp + BigInt(10))).do();

    makeApplicationOptInTxnFromObject({
      from: receiver1.addr,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      appIndex: assetIndex,
    });

    const atc = new AtomicTransactionComposer();
    const boxes: algosdk.BoxReference[] = new Array(2).fill({
      appIndex: Number((await appClient.appClient.getAppReference()).appId),
      name: bigIntToBytes(1, 8),
    });
    const senderSIgner = algosdk.makeBasicAccountTransactionSigner(sender);

    const xferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: receiver1.addr,
      to: receiver1.addr,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      assetIndex,
      amount: 0,
    });

    await algokit.sendTransaction({ transaction: xferTxn, from: receiver1 }, algod);
    await algosdk.waitForConfirmation(algod, xferTxn.txID(), 3);

    atc.addMethodCall({
      appID: (await appClient.appClient.getAppReference()).appId as number,
      method: contract.getMethodByName('executeWill'),
      methodArgs: [1],
      sender: sender.addr,
      signer: senderSIgner,
      suggestedParams: { ...(await algokit.getTransactionParams(undefined, algod)), fee: 5000 },
      boxes,
      appForeignAssets: [assetIndex],
      appAccounts: [receiver1.addr, receiver2.addr],
    });

    const initialAlgoResult1 = await algod.accountInformation(receiver1.addr).do();
    const initialAlgoResult2 = await algod.accountInformation(receiver2.addr).do();

    await atc.execute(algod, 4);
    const assetResult = await algod.accountAssetInformation(receiver1.addr, assetIndex).do();
    const algoResult1 = await algod.accountInformation(receiver1.addr).do();
    const algoResult2 = await algod.accountInformation(receiver2.addr).do();

    expect(assetResult['asset-holding'].amount === 100);
    expect((((algoResult1.amount as number) - initialAlgoResult1.amount) as number) === 123321);
    expect((((algoResult2.amount as number) - initialAlgoResult2.amount) as number) === 1111);
  });
});
