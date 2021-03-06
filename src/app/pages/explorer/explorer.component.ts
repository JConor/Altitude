import { Component } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ElectronService } from '../../providers/electron.service';
import { WalletService } from '../../providers/wallet.service';
import { ErrorService } from '../../providers/error.service';
import { NotificationService } from '../../providers/notification.service';
import Helpers from '../../helpers';

@Component({
  selector: 'app-explorer',
  templateUrl: './explorer.component.html'
})
export class ExplorerComponent {

  searchInput = '';

  currentBlock;
  currentTransaction;

  public helpers = Helpers;

  constructor(
    private notification: NotificationService,
    private wallet: WalletService,
    private errorService: ErrorService
  ) {

  }

  ngOnInit() {
    this.loadLatest()
  }

  async loadLatest() {
    if (this.wallet.walletStatus.latestBlockTime) {
      this.loadBlock(this.wallet.walletStatus.latestBlockHeight);
    } else {
      setTimeout(() => this.loadLatest(), 1000);
    }
  }

  async loadBlock(blockHeight: number, blockHash: string = "") {
    try {
      this.currentBlock = blockHash ? await this.wallet.getBlock(blockHash) : await this.wallet.getBlockByNumber(blockHeight);
    } catch (ex) {
      this.errorService.diagnose(ex);
    }
  }

  async loadTransaction(txId: string) {
    try {
      this.currentTransaction = await this.wallet.getTransaction(txId);
      this.currentBlock = null;
      this.loadTransactionInputs();
    } catch (ex) {
      this.errorService.diagnose(ex);
    }
  }

  async search() {
    if (!isNaN(Number(this.searchInput))) {
      // is a block height
      try {
        const result = await this.wallet.getBlockByNumber(Number(this.searchInput));
        this.currentBlock = result;
      } catch (ex) {
        this.errorService.diagnose(ex);
      }
    } else {
      //is block hash or transaction hash
      try {
        const result = await this.wallet.getBlock(this.searchInput);
        this.currentBlock = result;
      } catch (ex) {
        if (ex.error && ex.error.error && ex.error.error.code === -5)
          this.searchForTransaction()
        else
          this.errorService.diagnose(ex);
      }
    }
  }

  async searchForTransaction() {
    try {
      const result = await this.wallet.getTransaction(this.searchInput);
      this.currentBlock = null;
      this.currentTransaction = result;
      this.loadTransactionInputs();
    } catch (ex) {
      if (ex.error && ex.error.error && ex.error.error.code === -5)
        this.notification.notify("error", "PAGES.EXPLORER.SEARCHNORESULTS");
      else
        this.errorService.diagnose(ex);
    }
  }

  loadTransactionInputs() {
    // lookup input addresses
    this.currentTransaction.vin.forEach(vin => {
      if (vin.txid) {
        this.wallet.getTransaction(vin.txid).then(inputTransaction => {
          vin.addresses = inputTransaction.vout[vin.vout].scriptPubKey.addresses;
          vin.value = inputTransaction.vout[vin.vout].value;
        }, err => { });
      }
    })
  }

}
