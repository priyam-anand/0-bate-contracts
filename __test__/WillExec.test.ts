import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import { algos, getOrCreateKmdWalletAccount } from '@algorandfoundation/algokit-utils';
import algosdk, { Algodv2, AtomicTransactionComposer, bigIntToBytes } from 'algosdk';
import * as algokit from '@algorandfoundation/algokit-utils';
import fs from 'fs';
import path from 'path';
import { WillexecClient } from '../contracts/clients/WillexecClient';

const fixture = algorandFixture();

let appClient: WillexecClient;
let sender: algosdk.Account;
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
    // const algodClient = new algosdk.Algodv2(
    //   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    //   'http://localhost',
    //   4001
    // );
    // console.log(await algodClient.accountInformation((await appClient.appClient.getAppReference()).appAddress).do());
    await appClient.appClient.fundAppAccount(algokit.microAlgos(100000));

    const asset1 = 'SLUIOR5APCXTY25URFQTXYJQPJAEKPMOTLCXZYLTHCZ2TGKUYNY22Z7LPA';
    const asset2 = 'IT7GSYW4SL2NOODDDAZCOFDDKFL7VBCKCD6TBFUYTS2SCKYIYQSN2CZKRA';
    const assetspk = algosdk.decodeAddress(asset1);
    const assetpk2 = algosdk.decodeAddress(asset2);
    const assetsToPass = [...assetspk.publicKey].concat([...assetpk2.publicKey]) as unknown as Uint8Array;

    const amount1 = bigIntToBytes(123321, 8);
    const amount2 = bigIntToBytes(1111, 8);
    const amountsToPass = [...amount1].concat([...amount2]) as unknown as Uint8Array;

    const toToPass = [...assetpk2.publicKey].concat([...assetspk.publicKey]) as unknown as Uint8Array;

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

    const senderSIgner = algosdk.makeBasicAccountTransactionSigner(sender);

    const atc = new AtomicTransactionComposer();
    const boxes: algosdk.BoxReference[] = new Array(8).fill({
      appIndex: Number((await appClient.appClient.getAppReference()).appId),
      name: bigIntToBytes(1, 8),
    });

    atc.addMethodCall({
      appID: (await appClient.appClient.getAppReference()).appId as number,
      method: contract.getMethodByName('createWill'),
      methodArgs: [
        from,
        amountsToPass,
        amountsToPass,
        toToPass,
        amountsToPass,
        toToPass,
        Math.floor(Date.now() / 1000),
        { txn: payTxn, signer: senderSIgner },
      ],
      sender: sender.addr,
      signer: senderSIgner,
      suggestedParams: await algokit.getTransactionParams(undefined, algod),
      boxes,
    });

    const result = await atc.execute(algod, 4);
    console.log(result.methodResults[0].returnValue);

    const res = await appClient.increateEndTime({ willId: 1 }, { sender, boxes });
    console.log('res ', res);
  });
});
