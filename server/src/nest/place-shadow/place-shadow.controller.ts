import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import type {
  PlaceShadowExportResult,
  PlaceShadowPickResult,
  PlaceShadowSummaryResult,
} from '@trek/shared';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlaceShadowPickDto } from './place-shadow.dto';
import { PlaceShadowService } from './place-shadow.service';

/**
 * /api/place-shadow — the local corpus of "what was searched, what was picked".
 *
 * Writing is open to any signed-in user because any signed-in user is the one
 * doing the picking; reading is admin only, because the corpus is everybody's
 * searches and the person entitled to see that is the person running the
 * instance. Nothing here leaves the instance on its own.
 */
@Controller('api/place-shadow')
@UseGuards(JwtAuthGuard)
export class PlaceShadowController {
  constructor(private readonly shadow: PlaceShadowService) {}

  /**
   * 200 with `{ recorded: false }` when the log is off, rather than a 403.
   * The client posts this and moves on; a rejection would be a permanent error
   * in the console of every install that never switched the log on.
   */
  @Post('pick')
  @HttpCode(200)
  pick(@Body() body: PlaceShadowPickDto): PlaceShadowPickResult {
    return { recorded: this.shadow.record(body) };
  }

  @Get('summary')
  @UseGuards(JwtAuthGuard, AdminGuard)
  summary(): PlaceShadowSummaryResult {
    return this.shadow.summary();
  }

  @Get('export')
  @UseGuards(JwtAuthGuard, AdminGuard)
  export(@Query('after') after?: string): PlaceShadowExportResult {
    const parsed = Number(after);
    return this.shadow.export(Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined);
  }

  @Delete()
  @UseGuards(JwtAuthGuard, AdminGuard)
  clear(): { removed: number } {
    return { removed: this.shadow.clear() };
  }
}
