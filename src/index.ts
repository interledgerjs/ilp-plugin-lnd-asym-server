import { waitForClientReady } from '@grpc/grpc-js'
import BigNumber from 'bignumber.js'
import { registerProtocolNames } from 'btp-packet'
import debug from 'debug'
import { EventEmitter2 } from 'eventemitter2'
import createLogger from 'ilp-logger'
import { BtpPacket, IlpPluginBtpConstructorOptions } from 'ilp-plugin-btp'
import { BehaviorSubject } from 'rxjs'
import { promisify } from 'util'
import LightningAccount from './account'
import {
  createGrpcClient,
  createInvoiceStream,
  createLnrpc,
  createPaymentStream,
  GrpcConnectionOpts,
  InvoiceStream,
  LndService,
  PaymentStream,
  GrpcClient
} from './lightning'
import { LightningClientPlugin } from './plugins/client'
import { LightningServerPlugin, MiniAccountsOpts } from './plugins/server'
import {
  DataHandler,
  Logger,
  MemoryStore,
  MoneyHandler,
  PluginInstance,
  PluginServices,
  Store
} from './types/plugin'

// Re-export Lightning related-services
export * from './lightning'
export { LightningAccount }

registerProtocolNames(['peeringRequest', 'paymentRequest'])

// TODO Should the default handlers return ILP reject packets?

const defaultDataHandler: DataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler: MoneyHandler = () => {
  throw new Error('no money handler registered')
}

export interface LightningPluginOpts
  extends MiniAccountsOpts,
    IlpPluginBtpConstructorOptions {
  /**
   * "client" to connect to a single peer or parent server that is explicity specified
   * "server" to enable multiple clients to openly connect to the plugin
   */
  role: 'client' | 'server'

  /** Config to connection to a gRPC server, or an already-constructed LND service */
  lnd: GrpcConnectionOpts | LndService

  /** Bidirectional streaming RPC to send outgoing payments and receive attestations */
  paymentStream?: PaymentStream

  /** Streaming RPC of newly added or settled invoices */
  invoiceStream?: InvoiceStream

  /** Maximum allowed amount in satoshis for incoming packets (satoshis) */
  maxPacketAmount?: BigNumber.Value
}

export default class LightningPlugin extends EventEmitter2
  implements PluginInstance {
  static readonly version = 2
  readonly _log: Logger
  readonly _store: Store
  readonly _maxPacketAmount: BigNumber
  readonly _maxBalance: BigNumber
  readonly _accounts = new Map<string, LightningAccount>() // accountName -> account
  readonly _plugin: LightningServerPlugin | LightningClientPlugin
  _dataHandler: DataHandler = defaultDataHandler
  _moneyHandler: MoneyHandler = defaultMoneyHandler

  /** gRPC client for raw RPC calls */
  readonly _grpcClient?: GrpcClient

  /** Wrapper around gRPC client for the Lightning RPC service, with typed methods and messages */
  readonly _lightning: LndService

  /** Bidirectional streaming RPC to send outgoing payments and receive attestations */
  _paymentStream?: PaymentStream

  /** Streaming RPC of newly added or settled invoices */
  _invoiceStream?: InvoiceStream

  /**
   * Unique identififer and host the Lightning node of this instance:
   * [identityPubKey]@[hostname]:[port]
   */
  _lightningAddress?: string

  constructor(
    {
      role = 'client',
      lnd,
      paymentStream,
      invoiceStream,
      maxPacketAmount = Infinity,
      ...opts
    }: LightningPluginOpts,
    { log, store = new MemoryStore() }: PluginServices = {}
  ) {
    super()

    /*
     * Allow consumers to both inject the LND connection
     * externally or pass in the credentials, and the plugin
     * will create it for them.
     */
    const isConnectionOpts = (o: any): o is GrpcConnectionOpts =>
      (typeof o.tlsCert === 'string' || Buffer.isBuffer(o.tlsCert)) &&
      (typeof o.macaroon === 'string' || Buffer.isBuffer(o.macaroon)) &&
      typeof o.hostname === 'string'

    if (isConnectionOpts(lnd)) {
      this._grpcClient = createGrpcClient(lnd)
      this._lightning = createLnrpc(this._grpcClient)
    } else {
      this._lightning = lnd
    }

    this._paymentStream = paymentStream
    this._invoiceStream = invoiceStream

    this._store = store

    this._log = log || createLogger(`ilp-plugin-lightning-${role}`)
    this._log.trace =
      this._log.trace || debug(`ilp-plugin-lightning-${role}:trace`)

    this._maxPacketAmount = new BigNumber(maxPacketAmount)
      .absoluteValue()
      .decimalPlaces(0, BigNumber.ROUND_DOWN)

    this._maxBalance = new BigNumber(role === 'client' ? Infinity : 0).dp(
      0,
      BigNumber.ROUND_FLOOR
    )

    const loadAccount = (accountName: string) => this._loadAccount(accountName)
    const getAccount = (accountName: string) => {
      const account = this._accounts.get(accountName)
      if (!account) {
        throw new Error(`Account ${accountName} is not yet loaded`)
      }

      return account
    }

    this._plugin =
      role === 'server'
        ? new LightningServerPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )
        : new LightningClientPlugin(
            { getAccount, loadAccount, ...opts },
            { store, log }
          )

    this._plugin.on('connect', () => this.emitAsync('connect'))
    this._plugin.on('disconnect', () => this.emitAsync('disconnect'))
    this._plugin.on('error', e => this.emitAsync('error', e))
  }

  async _loadAccount(accountName: string): Promise<LightningAccount> {
    /** Create a stream from the value in the store */
    const loadValue = async (key: string) => {
      const storeKey = `${accountName}:${key}`
      const subject = new BehaviorSubject(
        new BigNumber((await this._store.get(storeKey)) || 0)
      )

      // Automatically persist it to the store
      subject.subscribe(value => this._store.put(storeKey, value.toString()))

      return subject
    }

    const payableBalance$ = await loadValue('payableBalance')
    const receivableBalance$ = await loadValue('receivableBalance')
    const payoutAmount$ = await loadValue('payoutAmount')

    // Account data must always be loaded from store before it's in the map
    if (!this._accounts.has(accountName)) {
      const account = new LightningAccount({
        sendMessage: (message: BtpPacket) =>
          this._plugin._sendMessage(accountName, message),
        dataHandler: (data: Buffer) => this._dataHandler(data),
        moneyHandler: (amount: string) => this._moneyHandler(amount),
        accountName,
        payableBalance$,
        receivableBalance$,
        payoutAmount$,
        master: this
      })

      // Since this account didn't previosuly exist, save it in the store
      this._accounts.set(accountName, account)
    }

    return this._accounts.get(accountName)!
  }

  async connect() {
    if (this._grpcClient) {
      await promisify(waitForClientReady)(this._grpcClient, Date.now() + 10000)
    }

    // Fetch public key & host for peering directly from LND
    const response = await this._lightning.getInfo({})
    this._lightningAddress = response.identityPubkey

    /*
     * Create only a single HTTP/2 stream per-plugin for
     * invoices and payments (not per-account)
     *
     * Create the streams after the connection has been established
     * (otherwise if the credentials turn out to be invalid,
     * this can throw some odd error messages)
     */
    if (!this._paymentStream) {
      this._paymentStream = createPaymentStream(this._lightning)
    }
    if (!this._invoiceStream) {
      this._invoiceStream = createInvoiceStream(this._lightning)
    }

    return this._plugin.connect()
  }

  async disconnect() {
    await this._plugin.disconnect()

    this._accounts.forEach(account => account.unload())
    this._accounts.clear()

    if (this._grpcClient) {
      this._grpcClient.close()
    }
  }

  isConnected() {
    return this._plugin.isConnected()
  }

  sendData(data: Buffer) {
    return this._plugin.sendData(data)
  }

  sendMoney(amount: string) {
    return this._plugin.sendMoney(amount)
  }

  registerDataHandler(dataHandler: DataHandler) {
    if (this._dataHandler !== defaultDataHandler) {
      throw new Error('request handler already registered')
    }

    this._dataHandler = dataHandler
    return this._plugin.registerDataHandler(dataHandler)
  }

  deregisterDataHandler() {
    this._dataHandler = defaultDataHandler
    return this._plugin.deregisterDataHandler()
  }

  registerMoneyHandler(moneyHandler: MoneyHandler) {
    if (this._moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler already registered')
    }

    this._moneyHandler = moneyHandler
    return this._plugin.registerMoneyHandler(moneyHandler)
  }

  deregisterMoneyHandler() {
    this._moneyHandler = defaultMoneyHandler
    return this._plugin.deregisterMoneyHandler()
  }
}
