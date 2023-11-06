import { Contract } from '@algorandfoundation/tealscript';

type Will = {
  from: Address;
  id: number;
  assets: bytes;
  assetsAmount: bytes;
  assetsTo: bytes;
  nativeAmount: bytes;
  nativeTo: bytes;
  endTime: number;
};

const COST_PER_BYTE = 400;
const COST_PER_BOX = 2500;
const MAX_BOX_SIZE = 8192;
const ONE_DAY = 86400;

// eslint-disable-next-line no-unused-vars
class Willexec extends Contract {
  wills = BoxMap<uint64, Will>();

  currentId = GlobalStateKey<uint64>({ key: 'id' });

  assetsHelper = GlobalStateMap<Asset, uint64>({ maxKeys: 8 });

  private verifyNative(nativeAmount: bytes, nativeTo: bytes): void {
    // verify native txn amounts etc
    const rounds = len(nativeAmount) / 8;
    assert(rounds === len(nativeTo) / 32);
    let totalCost =
      COST_PER_BOX + // cost of box
      MAX_BOX_SIZE * COST_PER_BYTE + // cost of data
      2 * 64 * COST_PER_BYTE; // cost of keys

    for (let i = 0; i < rounds; i = i + 1) {
      const currentAmountInBytes = extract3(nativeAmount, i * 8, 8);
      totalCost = totalCost + btoi(currentAmountInBytes);
    }

    verifyTxn(this.txnGroup[0], { receiver: this.app.address, amount: { greaterThanEqualTo: totalCost } });
  }

  private verifyAssets(assetsAmount: bytes, assetsTo: bytes, assets: bytes): void {
    const rounds = len(assetsAmount) / 8;
    assert(rounds === len(assets) / 8 && rounds === len(assetsTo) / 32);

    for (let i = 0; i < rounds; i = i + 1) {
      const currentAssetInBytes = extract3(assets, i * 8, 8);
      const currentAmountInBytes = extract3(assetsAmount, i * 8, 8);

      const currentAsset = Asset.fromID(btoi(currentAssetInBytes));
      const currentAmount = btoi(currentAmountInBytes);

      if (this.assetsHelper(currentAsset).exists) {
        const value = this.assetsHelper(currentAsset).value + currentAmount;
        this.assetsHelper(currentAsset).value = value;
      } else {
        this.assetsHelper(currentAsset).value = currentAmount;
      }
    }

    for (let i = 0; i < rounds; i = i + 1) {
      const currentAssetInBytes = extract3(assets, i * 8, 8);
      const currentAsset = Asset.fromID(btoi(currentAssetInBytes));
      const value = this.assetsHelper(currentAsset).value;
      // verify asset transfers from this group
      verifyTxn(this.txnGroup[i + 1], {
        xferAsset: currentAsset,
        assetAmount: { greaterThanEqualTo: value },
        assetReceiver: this.app.address,
      });
      // send these assets to a dex and store the output ????
      this.assetsHelper(currentAsset).delete();
    }
  }

  private createWillSanityChecks(
    nativeAmount: bytes,
    nativeTo: bytes,
    assetsAmount: bytes,
    assetsTo: bytes,
    assets: bytes,
    endTime: number
  ): void {
    this.verifyNative(nativeAmount, nativeTo);
    this.verifyAssets(assetsAmount, assetsTo, assets);
    assert(endTime > globals.latestTimestamp);
  }

  private sendNative(to: Address, amount: number): void {
    sendPayment({
      amount: amount,
      receiver: to,
      fee: 1000,
    });
  }

  private sendAsset(asset: Asset, to: Address, amount: number): void {
    sendAssetTransfer({
      xferAsset: asset,
      assetAmount: amount,
      assetReceiver: to,
    });
  }

  private getCurrentId(): number {
    return this.currentId.value;
  }

  private incrementCurrentId(): void {
    this.currentId.value = this.getCurrentId() + 1;
  }

  assetOptIn(asset: Asset): void {
    verifyTxn(this.txn, { sender: this.app.creator });
    sendAssetTransfer({
      assetReceiver: this.app.address,
      xferAsset: asset,
      assetAmount: 0,
    });
  }

  createWill(
    from: Address,
    assets: bytes,
    assetsAmount: bytes,
    assetsTo: bytes,
    nativeAmount: bytes,
    nativeTo: bytes,
    endTime: number
  ): uint64 {
    // necessary checks
    this.createWillSanityChecks(nativeAmount, nativeTo, assetsAmount, assetsTo, assets, endTime);

    // store the will
    this.incrementCurrentId();
    const id = this.getCurrentId();

    const will: Will = {
      from: from,
      id: id,
      assets: assets,
      assetsAmount: assetsAmount,
      assetsTo: assetsTo,
      nativeAmount: nativeAmount,
      nativeTo: nativeTo,
      endTime: endTime,
    };

    this.wills(this.currentId.value).value = will;

    return id;
  }

  increateEndTime(willId: number): void {
    const will = this.wills(willId).value;
    assert(this.txn.sender === will.from);
    const currentEndTime = this.wills(willId).value.endTime;
    this.wills(willId).value.endTime = currentEndTime + ONE_DAY * 365; // increase time by 1 year
  }

  executeWill(willId: number): void {
    const will = this.wills(willId).value;

    assert(globals.latestTimestamp >= will.endTime);

    // transfer algos
    let rounds = len(will.nativeAmount) / 8;
    for (let i = 0; i < rounds; i = i + 1) {
      const currentAmount = btoi(extract3(will.nativeAmount, i * 8, 8));
      const currentTo = Address.fromBytes(extract3(will.nativeTo, i * 32, 32));

      this.sendNative(currentTo, currentAmount);
    }

    // transfer assets
    rounds = len(will.assets) / 32;
    for (let i = 0; i < rounds; i = i + 1) {
      const currentAsset = Asset.fromID(btoi(extract3(will.assets, i * 32, 32)));
      const currentTo = Address.fromBytes(extract3(will.assetsTo, i * 32, 32));
      const currentAmount = btoi(extract3(will.assetsAmount, i * 8, 8));

      this.sendAsset(currentAsset, currentTo, currentAmount);
    }

    // delete used up box
    this.wills(willId).delete();
  }
}
