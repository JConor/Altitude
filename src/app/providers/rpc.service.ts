import { Injectable, isDevMode } from '@angular/core';
import Big from 'big.js';
import { ElectronService, ClientStatus } from './electron.service';
import { PromptService } from '../components/prompt/prompt.service';
import Helpers from '../helpers';
import { Transaction } from '../classes';
import * as compareVersions from 'compare-versions';

@Injectable()
export class RpcService {
    private encryptionStatus = 'Unencrypted';
    public clientStatus: ClientStatus;
    public RPCReady = false
    public RPCWarmupMessage = '';

    private RPCSubscriptions = {};

    // set to try when we are unlocking the wallet temporarily to access keys
    // so we can return it to it's original state
    private isUsingEncryption = false;

    private readonly unlockTimeout = 31000000;

    constructor(
        private electron: ElectronService,
        private prompt: PromptService
    ) {
        if (electron.isElectron()) this.setupListeners()
        else console.log("Not running in electron. cannot connect IPC");
    }

    setupListeners() {
        // electron for client status
        this.electron.clientStatusEvent.subscribe((status: ClientStatus) => {
            this.clientStatus = status;
            if (status === ClientStatus.CLOSEDUNEXPECTED) {
                this.stopClient();
                this.notifyClientCloseUnexpected();
            } else if (status === ClientStatus.STOPPED && this.RPCReady) {
                this.stopClient();
                this.notifyClientStopped();
            } else if (status === ClientStatus.INVALIDMASTERNODECONFIG) {
                this.stopClient();
                this.notifyClientInvalidConfig();
            } else if (status === ClientStatus.SHUTTINGDOWN) {
                this.stopClient();
            }
        });
        // electron for RPC status
        this.electron.RCPStatusEvent.subscribe((status: { ready: boolean, message: string }) => {
            this.RPCReady = status.ready;
            this.RPCWarmupMessage = status.message
        });
        // listen for RPC responses
        this.electron.RPCResponseEvent.subscribe(data => {
            let sub = this.RPCSubscriptions[data.callId];
            if (sub) {
                let result = data.result;
                let time = new Date().getTime() - sub.ts + 'ms';
                if (isDevMode()) console.log('CallServer Response', time, data.method, result);
                if (result.success) sub.resolve(result.body);
                else sub.reject(result);
                delete this.RPCSubscriptions[data.callId]
            }
        });
    }

    public stopClient() {
        this.RPCReady = false;
        this.cancelAllRPCCalls();
    }

    public restartClient(commands = []) {
        this.stopClient();
        this.electron.ipcRenderer.send('client-node', 'RESTART', commands);
    }

    public async requestData(method, params = []) {
        let data: any;
        switch (method) {
            case RPCMethods.ENCRYPT:
                data = await this.callServer("encryptwallet", params);
                break;
            case RPCMethods.CHANGEPASSPHRASE:
                data = await this.callServer("walletpassphrasechange", params);
                break;
            case RPCMethods.GETWALLET:
                data = await this.getWalletInfo();
                break;
            case RPCMethods.GETACCOUNTS:
                data = await this.getAccounts();
                break;
            case RPCMethods.GETTRANSACTIONS:
                data = await this.getTransactions(params);
                break;
            case RPCMethods.GETSTAKING:
                data = await this.callServer("getstakinginfo");
                break;
            case RPCMethods.UPDATELABEL:
                data = await this.callServer("setaccount", params);
                break;
            case RPCMethods.NEWADDRESS:
                data = await this.callServer("getaccountaddress", params);
                break;
            case RPCMethods.UNLOCK:
                data = await this.unlockWallet(params[0], this.unlockTimeout, params[1]);
                break;
            case RPCMethods.LOCK:
                await this.callServer("walletlock");
                data = { result: { success: true } };
                break;
            case RPCMethods.LOCKUNSPENT:
                data = await this.callServer("lockunspent", params);
                break;
            case RPCMethods.CREATETRANSACTION:
                data = await this.createTransaction(params);
                break;
            case RPCMethods.BACKUPWALLET:
                data = await this.callServer("backupwallet", params);
                break;
            case RPCMethods.GETLATESTBLOCK:
                data = await this.getLatestBlock();
                break;
            case RPCMethods.MASTERNODESTART:
                data = await this.callServer("masternode", ['start', ...params])
                break;
            case RPCMethods.MASTERNODESTARTALIAS:
                data = await this.callServer("masternode", ['start-alias', ...params])
                break;
            case RPCMethods.MASTERNODESTARTMANY:
                data = await this.callServer("masternode", ['start-many', ...params])
                break;
            case RPCMethods.MASTERNODESTATUS:
                data = await this.masternodeStatus();
                break;
            case RPCMethods.MASTERNODESTATUSALL:
                data = await this.callServer("masternode", ['status-all']);
                break;
            case RPCMethods.MASTERNODELISTCONF:
                data = await this.callServer("masternode", ['list-conf']);
                break;
            case RPCMethods.SIGNMESSAGE:
                data = await this.signMessage(params);
                break;
            case RPCMethods.VERIFYMESSAGE:
                data = await this.callServer("verifymessage", params);
                break;
            case RPCMethods.PEERS:
                data = await this.callServer("getpeerinfo");
                break;
            case RPCMethods.ADDRESSBOOKLIST:
                data = await this.callServer("listaddressbook");
                break;
            case RPCMethods.ADDRESSBOOKADD:
                data = await this.callServer("addressbookadd", params);
                break;
            case RPCMethods.ADDRESSBOOKREMOVE:
                data = await this.callServer("addressbookremove", params);
                break;
            case RPCMethods.GETBLOCK:
                data = await this.callServer("getblock", params);
                break;
            case RPCMethods.GETBLOCKBYNUMBER:
                data = await this.callServer("getblockbynumber", params);
                break;
            case RPCMethods.GETTRANSACTION:
                data = await this.callServer("gettransaction", params);
                break;
        }
        return data.result ? data.result : {};
    }

    private async unlockWallet(passphrase, timeout, stakingOnly = false) {
        try {
            const lockdata: any = await this.callServer("walletpassphrase", [passphrase, timeout, stakingOnly]);
            return lockdata;
        } catch (ex) {
            // if we called unlock when our wallet is already unlock or
            // unencrypted just ignore it
            if (ex.body.error.code === -15 || ex.body.error.code === -17)
                return {}
            else
                throw ex
        }
    }

    private async signMessage(params) {
        const [address, message, passphrase] = params;
        try {
            // unlock wallet
            if (passphrase) {
                await this.unlockWallet(passphrase, 5);
                this.isUsingEncryption = true;
            }
            const signdata: any = await this.callServer("signmessage", [address, message]);
            this.checkUnlock(passphrase);
            return signdata;
        } catch (ex) {
            this.checkUnlock(passphrase);
            throw ex;
        }
    }

    private async getLatestBlock() {
        let result = { height: 0, time: 0 };
        let data: any = await this.callServer('getbestblockhash');
        data = await this.callServer('getblock', [data.result]);
        result.height = data.result.height;
        result.time = data.result.time;
        return { result };
    }

    private async getAccounts() {
        // get addresses
        let addresses: any = await this.callServer("listreceivedbyaddress", [0, true]);
        // get address groupings
        let groups: any = await this.callServer("listaddressgroupings");
        // get all unspent
        let unspents: any = await this.listUnspent();
        // assemble accounts
        let accounts = [];
        for (let i = 0; i < groups.result.length; i++) {
            let grp = groups.result[i];
            let newAccount = [];
            for (let j = 0; j < grp.length; j++) {
                let newAddress = {
                    address: grp[j][0],
                    amount: 0,
                    account: grp[j][2],
                    unspents: []
                }
                if (newAddress.account !== undefined && newAccount.length) accounts.push([newAddress]);
                else newAccount.push(newAddress);
                // removing matching address in address list
                for (let k = 0; k < addresses.result.length; k++) {
                    if (addresses.result[k].address === newAddress.address) {
                        addresses.result.splice(k, 1);
                        break;
                    }
                }
            }
            accounts.push(newAccount);
        }
        // add remaining addresses from address list
        addresses.result.forEach(address => {
            if (address.account !== "(change)" || (address.account === "(change)" && address.amount !== "0")) {
                accounts.push([{
                    address: address.address,
                    amount: address.amount,
                    account: address.account,
                    unspents: []
                }]);
            }
        });
        // match unspent to address
        for (let i = 0; i < unspents.result.length; i++) {
            let unspent = unspents.result[i];
            for (let j = 0; j < accounts.length; j++) {
                let acc = accounts[j];
                let foundAddr = false;
                for (let k = 0; k < acc.length; k++) {
                    let addr = acc[k];
                    if (addr.address === unspent.address) {
                        addr.unspents.push({
                            amount: Helpers.fromSatoshi(Big(unspent.rawamount)) || unspent.amount,
                            blockTime: unspent.time,
                            confirmations: unspent.confirmations,
                            scriptPubKey: unspent.scriptPubKey,
                            txid: unspent.txid,
                            vout: unspent.vout,
                            locked: unspent.locked
                        });
                        unspents.result.splice(i--, 1);
                        foundAddr = true;
                        break;
                    }
                }
                if (foundAddr) break;
            }
        }

        // remove empty change addresses
        for (let i = 0; i < accounts.length; i++) {
            let acc = accounts[i];
            for (let j = 0; j < acc.length; j++) {
                let addr = acc[j];
                if (addr.account === '(change)' && !addr.unspents.length) {
                    acc.splice(j--, 1);
                }
            }
            if (!acc.length) accounts.splice(i--, 1);
        }

        return { result: accounts };
    }

    private async getWalletInfo() {
        let data: any = await this.callServer("getinfo");

        if (!this.isUsingEncryption)
            this.encryptionStatus = data.result.encryption_status

        return data;
    }

    private listUnspent() {
        // as of v3.4 listunspent now has a watchonlyconfig flag
        if (compareVersions(this.electron.clientVersion, '3.4.0.0') >= 0)
            return this.callServer("listunspent", [1, 9999999, [], 1, true]);
        else
            return this.callServer("listunspent", [1, 9999999, [], true]);
    }

    private async createTransaction(params) {
        let [inputs, outputs, fee, passphrase, changeAddress] = params;
        try {
            // get unspents
            let unspents: any = await this.listUnspent();
            unspents = unspents.result;
            // safety check inputs
            let sendingBalance = Big(0);
            for (let i = 0; i < inputs.length; i++) {
                let input = inputs[i];
                let foundMatch = false;
                for (let j = 0; j < unspents.length; j++) {
                    let unspent = unspents[j];
                    if (input.txid === unspent.txid && input.vout === unspent.vout) {
                        if (unspent.confirmations < 1) {
                            return { result: { success: false, error: "NOTIFICATIONS.MINIMUMCONFIRMATIONS" } };
                        }
                        foundMatch = true;
                        let unspentAmount = Helpers.fromSatoshi(Big(unspent.rawamount)) || Big(unspent.amount);
                        sendingBalance = sendingBalance.add(unspentAmount);
                        break;
                    }
                }
                if (!foundMatch) return { result: { success: false, error: "NOTIFICATIONS.TRANSACTIONMISMATCH" } };
            }
            let isUnsafeTransaction = false;
            // get total receiving
            let recevingBalance = Big(fee);
            Object.keys(outputs).forEach(address => {
                recevingBalance = recevingBalance.add(outputs[address]);
                if (this.isUnsafeAmount(outputs[address])) isUnsafeTransaction = true;
            })
            // Core V3.3.0 and older cannot create transactions that would produce a number overflow
            if (isUnsafeTransaction && !this.canSendUnsafeTransaction)
                return { result: { success: false, error: "NOTIFICATIONS.TRANSACTIONOUTPUTTOOLARGE" } };

            // safety check
            if (sendingBalance.lt(recevingBalance)) {
                return { result: { success: false, error: "NOTIFICATIONS.TRANSACTIONMISMATCH" } };
            }
            // calculate change
            let change = sendingBalance.minus(recevingBalance);
            // unlock wallet
            if (passphrase) {
                await this.unlockWallet(passphrase, 5);
                this.isUsingEncryption = true;
            }
            // create change address
            if (change.gt(0)) {
                if (!changeAddress) {
                    let changeRequest: any = await this.callServer("getnewaddress", ['(change)']);
                    changeAddress = changeRequest.result;
                }
                if (outputs[changeAddress])
                    outputs[changeAddress] = outputs[changeAddress].add(change);
                else
                    outputs[changeAddress] = change;

                if (this.isUnsafeAmount(outputs[changeAddress])) {
                    isUnsafeTransaction = true;
                    if (!this.canSendUnsafeTransaction)
                        return { result: { success: false, error: "NOTIFICATIONS.TRANSACTIONCHANGETOOLARGE" } };
                }
            }

            // create raw transaction
            let raw: any;
            if (!isUnsafeTransaction) {
                // convert outputs to number
                Object.keys(outputs).forEach(key => {
                    outputs[key] = Number(outputs[key]);
                })
                raw = await this.callServer("createrawtransaction", [inputs, outputs]);
                raw = raw.result;
            } else {
                // starting Core 3.3.1 we can send transactions as string and in satoshi
                // to avoid overflow issues from javascipt
                Object.keys(outputs).forEach(key => {
                    outputs[key] = Helpers.toSatoshi(outputs[key]).toString();
                })
                raw = await this.callServer("createpreciserawtransaction", [inputs, outputs]);
                raw = raw.result;
            }
            // confirm the fee
            let actualFee = Math.ceil(raw.length / 1000) * Helpers.params.fee;
            if (actualFee > Number(fee)) {
                return { result: { success: false, newFee: actualFee } };
            } else {
                // sign raw transaction
                let signed: any = await this.callServer("signrawtransaction", [raw]);
                this.checkUnlock(passphrase);
                signed = signed.result.hex;
                // send raw transaction
                await this.callServer("sendrawtransaction", [signed]);
                return { result: { success: true } };
            }
        } catch (ex) {
            this.checkUnlock(passphrase);
            throw ex;
        }
    }

    private get canSendUnsafeTransaction() {
        return compareVersions(this.electron.clientVersion, '3.3.1.0') >= 0
    }

    private isUnsafeAmount(amount: number | Big) {
        // js must convert to a number to send it to the daemon
        // this limits the maximum we can send as 90,071,992.54740992
        // otherwise there are overflow errors
        // we'll update lindacore in the future to handle strings
        // so we can circumvent this issue
        if (Big(amount).times(100000000).gt(9007199254740992))
            return true;
        return false;
    }

    private checkUnlock(passphrase) {
        try {
            this.isUsingEncryption = false;
            if (passphrase) {
                if (this.encryptionStatus === 'LockedForStaking')
                    this.unlockWallet(passphrase, this.unlockTimeout, true)
                else if (this.encryptionStatus === 'Unlocked')
                    this.unlockWallet(passphrase, this.unlockTimeout)
            }
        } catch (ex) {

        }
    }

    private async getTransactions(params) {
        let outputs = new Array<Transaction>();
        let count = params[0] || 10;
        let from = params[1] || 0;

        // load all transactions
        let data: any = await this.callServer('listtransactions', ['*', count, from]);
        // get address
        data.result.forEach(tx => {
            outputs.push(new Transaction(tx))
        })

        // group payments to self
        outputs.forEach((output, index) => {
            for (let i = index + 1; i < outputs.length; i++) {
                // check if payment to self
                if (
                    output.txId === outputs[i].txId &&
                    output.address === outputs[i].address &&
                    output.amount.abs().cmp(outputs[i].amount.abs()) == 0
                ) {
                    output.amount = output.amount.abs()
                    output.category = "Payment To Self";
                    output.fee = output.fee || outputs[i].fee;
                    outputs.splice(i, 1);
                    break;
                }
            }
        })

        return { result: outputs };
    }

    private async masternodeStatus() {
        // check initialised
        let init: any = await this.callServer("masternode", ['isInit']);
        return { result: { initRequired: !init.result } };
    }

    public callServer(method, params = []) {
        return new Promise((resolve, reject) => {
            let callId = Helpers.guid();
            this.RPCSubscriptions[callId] = { resolve, reject, ts: new Date().getTime() };
            const callData = { callId, method, params }
            this.electron.ipcRenderer.send('client-node', 'CALLCLIENT', callData);
        })
    }

    cancelAllRPCCalls() {
        Object.keys(this.RPCSubscriptions).forEach(key => {
            this.RPCSubscriptions[key].reject({ rpcCancelled: true });
        })
        this.RPCSubscriptions = {};
    }

    async notifyClientStopped() {
        // if we lost connection to external client. notify user
        try {
            await this.prompt.alert('COMPONENTS.PROMPT.CLIENTSTOPPEDTITLE', 'COMPONENTS.PROMPT.CLIENTSTOPPEDINFO', 'COMPONENTS.PROMPT.CLIENTSTOPPEDBUTTONSTART', 'COMPONENTS.PROMPT.CLIENTSTOPPEDBUTTONEXIT');
            // start internal client
            this.restartClient();
        } catch (ex) {
            // chose to stop wallet
            this.electron.remote.app.quit()
        }
    }

    async notifyClientCloseUnexpected() {
        try {
            await this.prompt.alert('COMPONENTS.PROMPT.CLIENTCLOSEDUNEXPECTEDTITLE', 'COMPONENTS.PROMPT.CLIENTCLOSEDUNEXPECTEDINFO', 'COMPONENTS.PROMPT.CLIENTCLOSEDUNEXPECTEDBUTTONSTART', 'COMPONENTS.PROMPT.CLIENTSTOPPEDBUTTONEXIT');
            // restart internal client
            this.restartClient();
        } catch (ex) {
            // chose to stop wallet
            this.electron.remote.app.quit()
        }
    }

    async notifyClientInvalidConfig() {
        // if we tried starting the client but the config has a bad masternode setup
        // that will just cause the client to exit
        try {
            await this.prompt.alert('COMPONENTS.PROMPT.CLIENTINVALIDCONFIGTITLE', 'COMPONENTS.PROMPT.CLIENTINVALIDCONFIGINFO', 'COMPONENTS.PROMPT.CLIENTSTOPPEDBUTTONSTART', 'COMPONENTS.PROMPT.CLIENTSTOPPEDBUTTONEXIT');
            // start internal client
            this.restartClient();
        } catch (ex) {
            // chose to stop wallet
            this.electron.remote.app.quit()
        }
    }
}

export enum RPCMethods {
    ENCRYPT,
    CHANGEPASSPHRASE,
    GETWALLET,
    GETACCOUNTS,
    GETTRANSACTIONS,
    GETTOTALS,
    GETSTAKING,
    UPDATELABEL,
    NEWADDRESS,
    UNLOCK,
    LOCK,
    LOCKUNSPENT,
    CREATETRANSACTION,
    GETLATESTBLOCK,
    MASTERNODESTART,
    MASTERNODESTARTMANY,
    MASTERNODESTARTALIAS,
    MASTERNODESTATUS,
    MASTERNODESTATUSALL,
    MASTERNODELISTCONF,
    BACKUPWALLET,
    SIGNMESSAGE,
    VERIFYMESSAGE,
    PEERS,
    ADDRESSBOOKLIST,
    ADDRESSBOOKADD,
    ADDRESSBOOKREMOVE,
    GETBLOCK,
    GETBLOCKBYNUMBER,
    GETTRANSACTION
}