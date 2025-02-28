import { ExchangeContract, SupportedProvider } from '@0x/contract-wrappers';
import addresses from '../addresses.json';
import { ChainId } from '../utils/eth';
import {
  buildOrder as _buildOrder,
  signOrder as _signOrder,
  sendSignedOrderToEthereum as _sendSignedOrderToEthereum,
  approveAsset as _approveAsset,
  getApprovalStatus as _getApprovalStatus,
  ApprovalStatus,
  getProxyAddressForErcType,
} from './pure';
import { SupportedTokenTypes } from '../utils/order';
import { UnexpectedAssetTypeError } from './error';
import type {
  BaseProvider,
  TransactionReceipt,
} from '@ethersproject/providers';
import type { ContractTransaction } from '@ethersproject/contracts';
import type { InterallySupportedAssetFormat } from './pure';
import type {
  UserFacingERC1155AssetDataSerializedNormalizedSingle,
  UserFacingERC20AssetDataSerialized,
  UserFacingERC721AssetDataSerialized,
} from '../utils/order';
import type { Order, SignedOrder } from './types';

interface NftSwapConfig {
  exchangeContractAddress?: string;
}

interface INftSwap {
  signOrder: (
    order: Order,
    signerAddress: string,
    provider: BaseProvider
  ) => Promise<SignedOrder>;
  buildOrder: (
    makerAssets: Array<SwappableAsset>,
    takerAssets: Array<SwappableAsset>,
    makerAddress: string,
    orderConfig?: Partial<BuildOrderAdditionalConfig>
  ) => Order;
  loadApprovalStatus: (
    asset: SwappableAsset,
    walletAddress: string,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) => Promise<ApprovalStatus>;
  approveTokenOrNftByAsset: (
    asset: SwappableAsset,
    walletAddress: string,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) => Promise<ContractTransaction>;
  fillSignedOrder: (
    signedOrder: SignedOrder,
    fillOrderOverrides?: Partial<FillOrderOverrides>
  ) => Promise<string>;
  awaitTransactionHash: (txHash: string) => Promise<TransactionReceipt>;
}

/**
 * All optional
 */
export interface BuildOrderAdditionalConfig {
  chainId?: number;
  takerAddress?: string;
  expiration?: Date;
  exchangeAddress?: string;
  salt?: string;
}

export type SwappableAsset =
  | UserFacingERC20AssetDataSerialized
  | UserFacingERC721AssetDataSerialized
  | UserFacingERC1155AssetDataSerializedNormalizedSingle;

const convertAssetToInternalFormat = (
  swappable: SwappableAsset
): InterallySupportedAssetFormat => {
  switch (swappable.type) {
    // No converting needed
    case 'ERC20':
      return swappable;
    // No converting needed
    case 'ERC721':
      return swappable;
    // Convert normalized public ERC1155 interface to 0x internal asset data format
    // We do this to reduce complexity for end user SDK (and keep api same with erc721)
    case 'ERC1155':
      const zeroExErc1155AssetFormat = {
        tokenAddress: swappable.tokenAddress,
        tokens: [
          {
            tokenId: swappable.tokenId,
            tokenValue: '1',
          },
        ],
        type: SupportedTokenTypes.ERC1155 as const,
      };
      return zeroExErc1155AssetFormat;
    default:
      throw new UnexpectedAssetTypeError((swappable as any)?.type ?? 'Unknown');
  }
};

const convertAssetsToInternalFormat = (
  assets: Array<SwappableAsset>
): Array<InterallySupportedAssetFormat> => {
  return assets.map(convertAssetToInternalFormat);
};

export interface ApprovalOverrides {
  provider: BaseProvider;
  approve: boolean;
  exchangeProxyContractAddressForAsset: string;
  chainId: number;
}

export interface FillOrderOverrides {
  signer: BaseProvider;
  exchangeContract: ExchangeContract;
}

/**
 * Convenience wrapper to swap between ERC20,ERC721,and ERC1155
 */
class NftSwap implements INftSwap {
  public provider: BaseProvider;
  public chainId: number;
  public exchangeContract: ExchangeContract;

  constructor(
    provider: BaseProvider,
    chainId: ChainId,
    additionalConfig?: NftSwapConfig
  ) {
    this.provider = provider;
    this.chainId = chainId;

    const zeroExExchangeContractAddress =
      additionalConfig?.exchangeContractAddress ?? addresses[chainId]?.exchange;

    if (!zeroExExchangeContractAddress) {
      throw new Error(
        `Chain ${chainId} missing exchange contract address. Supply one manually via the constructor config param`
      );
    }

    this.exchangeContract = new ExchangeContract(
      zeroExExchangeContractAddress,
      provider as unknown as SupportedProvider
    );
  }

  public awaitTransactionHash = async (txHash: string) => {
    return this.provider.waitForTransaction(txHash);
  };

  public signOrder = async (
    order: Order,
    addressOfWalletSigningOrder: string,
    signer: BaseProvider = this.provider
  ) => {
    return _signOrder(order, addressOfWalletSigningOrder, signer);
  };

  public buildOrder = (
    makerAssets: SwappableAsset[],
    takerAssets: SwappableAsset[],
    makerAddress: string,
    userConfig?: Partial<BuildOrderAdditionalConfig>
  ) => {
    const defaultConfig = { chainId: this.chainId, makerAddress: makerAddress };
    const config = { ...defaultConfig, ...userConfig };
    return _buildOrder(
      convertAssetsToInternalFormat(makerAssets),
      convertAssetsToInternalFormat(takerAssets),
      config
    );
  };

  public loadApprovalStatus = async (
    asset: SwappableAsset,
    walletAddress: string,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) => {
    const exchangeProxyAddressForAsset = getProxyAddressForErcType(
      asset.type as SupportedTokenTypes,
      this.chainId
    );
    return _getApprovalStatus(
      walletAddress,
      approvalOverrides?.exchangeProxyContractAddressForAsset ??
        exchangeProxyAddressForAsset,
      convertAssetToInternalFormat(asset),
      approvalOverrides?.provider ?? this.provider
    );
  };

  /**
   * Convenience wrapper around internal approveTokenOrNft
   * @param asset Asset in the SDK format
   * @returns
   */
  public async approveTokenOrNftByAsset(
    asset: SwappableAsset,
    walletAddress: string,
    approvalOverrides?: Partial<ApprovalOverrides>
  ) {
    const exchangeProxyAddressForAsset = getProxyAddressForErcType(
      asset.type as SupportedTokenTypes,
      this.chainId
    );
    return _approveAsset(
      walletAddress,
      approvalOverrides?.exchangeProxyContractAddressForAsset ??
        exchangeProxyAddressForAsset,
      convertAssetToInternalFormat(asset),
      approvalOverrides?.provider ?? this.provider,
      approvalOverrides?.approve ?? true
    );
  }

  public fillSignedOrder = async (
    signedOrder: SignedOrder,
    fillOrverrides?: Partial<FillOrderOverrides>
  ) => {
    return _sendSignedOrderToEthereum(
      signedOrder,
      fillOrverrides?.exchangeContract ?? this.exchangeContract
    );
  };
}

export { NftSwap };
