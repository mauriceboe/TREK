import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { registerTodoTools } from './tools/todos';
import { registerFileTools } from './tools/files';
import { registerAssignmentTools } from './tools/assignments';
import { registerReservationTools } from './tools/reservations';
import { registerTagTools } from './tools/tags';
import { registerMapsWeatherTools } from './tools/mapsWeather';
import { registerNotificationTools } from './tools/notifications';
import { registerAtlasTools } from './tools/atlas';
import { registerPlaceTools } from './tools/places';
import { registerDayTools } from './tools/days';
import { registerBudgetTools } from './tools/budget';
import { registerPackingTools } from './tools/packing';
import { registerCollabTools } from './tools/collab';
import { registerTripTools } from './tools/trips';
import { registerVacayTools } from './tools/vacay';
import { registerMcpPrompts } from './tools/prompts';

export function registerTools(server: McpServer, userId: number): void {
  registerTripTools(server, userId);

  registerPlaceTools(server, userId);

  registerBudgetTools(server, userId);

  registerPackingTools(server, userId);

  registerReservationTools(server, userId);

  registerDayTools(server, userId);

  registerAssignmentTools(server, userId);

  registerTagTools(server, userId);

  registerMapsWeatherTools(server, userId);

  registerNotificationTools(server, userId);

  registerAtlasTools(server, userId);

  registerCollabTools(server, userId);

  registerFileTools(server, userId);

  registerVacayTools(server, userId);

  registerTodoTools(server, userId);

  registerMcpPrompts(server, userId);
}
