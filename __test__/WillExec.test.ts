import { describe, test, beforeAll, beforeEach } from '@jest/globals';
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

const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/artifacts/Willexec.abi.json'), 'utf8'));
const contract = new algosdk.ABIContract(abi);
let algod: Algodv2;
describe('Willexec', () => {
  beforeEach(fixture.beforeEach);

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
    receiver1 = await getOrCreateKmdWalletAccount(
      {
        name: 'receiver1',
        fundWith: algos(10),
      },
      algod,
      kmd
    );
    receiver2 = await getOrCreateKmdWalletAccount(
      {
        name: 'receiver2',
        fundWith: algos(10),
      },
      algod,
      kmd
    );
    sender = await getOrCreateKmdWalletAccount(
      {
        name: 'currentSender2',
        fundWith: algos(10000),
      },
      algod,
      kmd
    );
    await appClient.create.createApplication({});
  });

  test('createWill ', async () => {
    const from = sender.addr;
    await appClient.appClient.fundAppAccount(algokit.microAlgos(100000));

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

    const topk1 = algosdk.decodeAddress(receiver1.addr);
    const topk2 = algosdk.decodeAddress(receiver2.addr);
    const toToPass = [...topk1.publicKey].concat([...topk2.publicKey]) as unknown as Uint8Array;

    const amount1 = bigIntToBytes(123321, 8);
    const amount2 = bigIntToBytes(1111, 8);
    const amountsToPass = [...amount1].concat([...amount2]) as unknown as Uint8Array;

    const assetAmount1 = bigIntToBytes(100, 8);
    const assetAmountToPass = assetAmount1;

    const asset1Index = assetResult['asset-index'];
    assetIndex = asset1Index;
    const asset1 = bigIntToBytes(asset1Index, 8);
    const assetsToPass = asset1;
    await appClient.appClient.fundAppAccount(algokit.microAlgos(100000));
    await appClient.assetOptIn(
      { asset: asset1Index },
      {
        sendParams: {
          fee: algokit.microAlgos(2000), // fee for itxn
        },
      }
    );

    const COST_PER_BYTE = 400;
    const COST_PER_BOX = 2500;
    const MAX_BOX_SIZE = 8192;

    const totalCost =
      COST_PER_BOX + // cost of box
      MAX_BOX_SIZE * COST_PER_BYTE + // cost of data
      64 * COST_PER_BYTE + // cost of key
      64 * COST_PER_BYTE + // cost of key
      123321 +
      1111;
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
      assetIndex: asset1Index,
      amount: 1000,
    });
    const senderSIgner = algosdk.makeBasicAccountTransactionSigner(sender);

    const atc = new AtomicTransactionComposer();
    const boxes: algosdk.BoxReference[] = new Array(8).fill({
      appIndex: Number((await appClient.appClient.getAppReference()).appId),
      name: bigIntToBytes(1, 8),
    });
    const status = await algod.status().do();
    const latestBlock = status['last-round'];
    const blockInfo = await algod.block(latestBlock).do();
    const timestamp = BigInt(blockInfo['block']['ts'] as number);
    console.log(typeof blockInfo['block']['ts'], blockInfo['block']['ts']);

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

    const result = await atc.execute(algod, 4);
    console.log(result.methodResults[0].returnValue);
  });

  test('extendTime ', async () => {});

  test('execute will ', async () => {
    const status = await algod.status().do();
    const latestBlock = status['last-round'];
    const blockInfo = await algod.block(latestBlock).do();
    const timestamp = BigInt(blockInfo['block']['ts'] as number);

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
    atc.addMethodCall({
      appID: (await appClient.appClient.getAppReference()).appId as number,
      method: contract.getMethodByName('executeWill'),
      methodArgs: [1],
      sender: sender.addr,
      signer: senderSIgner,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      boxes,
      appForeignAssets: [assetIndex],
      appAccounts: [receiver1.addr, receiver2.addr],
    });

    const result = await atc.execute(algod, 4);
    console.log(result);
  });
});
