import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { logError, logInfo } from '../audit/audit-log.logger';
import { CronRegistrarService } from '../scheduling/cron-registrar.service';
import { PlaceShadowService } from './place-shadow.service';

/**
 * Nightly retention for the shadow corpus.
 *
 * Runs even when the log is switched off, on purpose: switching it off should
 * also let what it already collected age out, rather than freezing the rows in
 * place until somebody remembers to press the wipe button.
 *
 * 3:40 AM keeps it clear of the 3:00 idempotency purge and the backup window.
 */
@Injectable()
export class PlaceShadowRetentionJob implements OnApplicationBootstrap {
  constructor(
    private readonly shadow: PlaceShadowService,
    private readonly registrar: CronRegistrarService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.registrar.isEnabled()) return;
    this.registrar.register('place-shadow-retention', '40 3 * * *', () => this.tick());
  }

  tick(): void {
    try {
      const removed = this.shadow.purgeExpired();
      if (removed > 0) {
        logInfo(`Place shadow retention: removed ${removed} expired row(s)`);
      }
    } catch (err: unknown) {
      logError(`Place shadow retention: ${err instanceof Error ? err.message : err}`);
    }
  }
}
