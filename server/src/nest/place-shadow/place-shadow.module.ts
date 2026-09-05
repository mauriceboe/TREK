import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PlaceShadowController } from './place-shadow.controller';
import { PlaceShadowRetentionJob } from './place-shadow.job';
import { PlaceShadowService } from './place-shadow.service';

/**
 * Place shadow log. Registered in AppModule; exports the service so the admin
 * surface can read the summary without going through HTTP.
 */
@Module({
  imports: [SchedulingModule],
  controllers: [PlaceShadowController],
  providers: [PlaceShadowService, PlaceShadowRetentionJob],
  exports: [PlaceShadowService],
})
export class PlaceShadowModule {}
