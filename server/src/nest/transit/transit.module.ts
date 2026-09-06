import { RateLimitModule } from '../common/rate-limit.module';
import { Module } from '@nestjs/common';
import { TransitController } from './transit.controller';
import { TransitService } from './transit.service';
import { TransitMcp } from './transit.mcp';
import { GoogleTransitProvider } from './google-transit.provider';
import { DaysModule } from '../days/days.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { AuthModule } from '../auth/auth.module';
import { McpSharedModule } from '../mcp-shared/mcp-shared.module';

/**
 * Transit domain (#1065) — the Transitous/MOTIS proxy, with the optional
 * Google backend (#1699) behind it. TransitMcp carries the
 * decorator-registered MCP tools; DaysModule/ReservationsModule feed
 * create_transit_journey. Exports TransitService for in-container consumers.
 */
@Module({
  // DaysModule + ReservationsModule: TransitMcp's create_transit_journey injects both.
  imports: [McpSharedModule, RateLimitModule, DaysModule, ReservationsModule, AuthModule],
  controllers: [TransitController],
  providers: [TransitService, TransitMcp, GoogleTransitProvider],
  exports: [TransitService],
})
export class TransitModule {}
