# MCP Addon Tools and Resources

This page covers MCP tools and resources that require specific addons to be enabled on your TREK instance. For core tools (trips, places, day planning, accommodations, transport, reservations, budget, tags, maps, and notifications) see [MCP-Tools-and-Resources](MCP-Tools-and-Resources).

---

## Addon-gated tools

### Packing _(Packing addon required)_

Requires `packing:read` or `packing:write` scope.

| Tool | Description |
|---|---|
| `create_packing_item` | Add an item to the packing checklist with optional category. |
| `update_packing_item` | Rename an item or change its category. |
| `toggle_packing_item` | Check or uncheck a packing item. |
| `delete_packing_item` | Remove a packing item. |
| `reorder_packing_items` | Set the display order of packing items within a trip. |
| `bulk_import_packing` | Import multiple packing items at once from a list (with optional quantity). |
| `apply_packing_template` | Apply a saved packing template to a trip. |
| `save_packing_template` | Save the current packing list as a reusable template. |
| `list_packing_bags` | List all packing bags for a trip. |
| `create_packing_bag` | Create a new packing bag (e.g. "Carry-on", "Checked bag"). |
| `update_packing_bag` | Rename or recolor a packing bag. |
| `delete_packing_bag` | Delete a packing bag (items are unassigned, not deleted). |
| `set_bag_members` | Assign trip members to a packing bag. |
| `get_packing_category_assignees` | Get which trip members are assigned to each packing category (shared categories only). |
| `set_packing_category_assignees` | Assign trip members to a shared packing category (resolved by name). |
| `list_packing_categories` | List packing categories for a trip. Other users' private categories are hidden. |
| `create_packing_category` | Create a packing category with a visibility type (`shared`, `personal`, or `private`). |
| `update_packing_category` | Rename a packing category or change its visibility type. |
| `delete_packing_category` | Delete a packing category and all of its items. |

### To-Dos _(Packing addon required)_

Requires `todos:read` or `todos:write` scope.

| Tool | Description |
|---|---|
| `list_todos` | List all to-do items for a trip, ordered by position. |
| `create_todo` | Create a to-do item with name, category, due date, description, assignee, and priority. |
| `update_todo` | Update an existing to-do item. Pass `null` to clear nullable fields. |
| `toggle_todo` | Mark a to-do item as done or undone. |
| `delete_todo` | Delete a to-do item. |
| `reorder_todos` | Reorder to-do items by providing a new ordered list of IDs. |
| `get_todo_category_assignees` | Get the default assignees configured per to-do category for a trip. |
| `set_todo_category_assignees` | Set default assignees for a to-do category. Pass an empty array to clear. |

### Atlas _(Atlas addon required)_

Requires `atlas:read` or `atlas:write` scope.

| Tool | Description |
|---|---|
| `mark_country_visited` | Mark a country as visited using its ISO 3166-1 alpha-2 code (e.g. `"FR"`, `"JP"`). |
| `unmark_country_visited` | Remove a country from your visited list. |
| `get_atlas_stats` | Get atlas statistics — visited country counts, region counts, and continent breakdown. |
| `list_visited_regions` | List all manually visited sub-country regions for the current user. |
| `mark_region_visited` | Mark a sub-country region as visited (e.g. `"US-CA"`). |
| `unmark_region_visited` | Remove a region from the visited list. |
| `get_country_atlas_places` | Get places saved in the user's atlas for a specific country. |
| `create_bucket_list_item` | Add a destination to your personal bucket list with optional coordinates and country code. |
| `update_bucket_list_item` | Update a bucket list item (name, notes, coordinates, target date). |
| `delete_bucket_list_item` | Remove an item from your bucket list. |

### Collab _(Collab addon required)_

Requires `collab:read` or `collab:write` scope.

| Tool | Description |
|---|---|
| `create_collab_note` | Create a shared note visible to all trip members. Supports title, content, category, and color. |
| `update_collab_note` | Edit a collab note's content, category, color, or pin status. |
| `delete_collab_note` | Delete a collab note. |
| `list_collab_polls` | List all polls for a trip. |
| `create_collab_poll` | Create a poll with a question, options, optional multiple choice, and deadline. |
| `vote_collab_poll` | Vote on a poll option (or remove vote if already voted). |
| `close_collab_poll` | Close a poll so no more votes can be cast. |
| `delete_collab_poll` | Delete a poll and all its votes. |
| `list_collab_messages` | List chat messages for a trip (most recent 100, supports pagination via `before`). |
| `send_collab_message` | Send a chat message to a trip's collab channel, with optional reply threading. |
| `delete_collab_message` | Delete a chat message (own messages only). |
| `react_collab_message` | Toggle a reaction emoji on a chat message. |

### Vacay _(Vacay addon required)_

Requires `vacay:read` or `vacay:write` scope.

| Tool | Description |
|---|---|
| `get_vacay_plan` | Get the current user's active vacation plan. |
| `update_vacay_plan` | Update vacation plan settings (weekend blocking, holidays, carry-over). |
| `set_vacay_color` | Set the current user's color in the vacation plan calendar. |
| `get_available_vacay_users` | List users who can be invited to the current vacation plan. |
| `send_vacay_invite` | Invite a user to join the vacation plan by their user ID. |
| `accept_vacay_invite` | Accept a pending invitation to join another user's vacation plan. |
| `decline_vacay_invite` | Decline a pending vacation plan invitation. |
| `cancel_vacay_invite` | Cancel an outgoing invitation (owner only). |
| `dissolve_vacay_plan` | Dissolve the shared plan — all members return to their own individual plan. |
| `list_vacay_years` | List calendar years tracked in the current vacation plan. |
| `add_vacay_year` | Add a calendar year to the vacation plan. |
| `delete_vacay_year` | Remove a calendar year from the vacation plan. |
| `get_vacay_entries` | Get all vacation day entries for the active plan and a specific year. |
| `toggle_vacay_entry` | Toggle a day on or off as a vacation day for the current user. |
| `toggle_company_holiday` | Toggle a date as a company holiday for the whole plan. |
| `get_vacay_stats` | Get vacation statistics for a specific year (days used, remaining, carried over). |
| `update_vacay_stats` | Update the vacation day allowance for a specific user and year. |
| `add_holiday_calendar` | Add a public holiday calendar (by region code) to the vacation plan. |
| `update_holiday_calendar` | Update label or color for a holiday calendar. |
| `delete_holiday_calendar` | Remove a holiday calendar from the vacation plan. |
| `list_holiday_countries` | List countries available for public holiday calendars. |
| `list_holidays` | List public holidays for a country and year. |

### Journey _(Journey addon required)_

Requires `journey:read` or `journey:write` scope.

| Tool | Description |
|---|---|
| `list_journeys` | List all journeys owned or contributed to by the current user. |
| `get_journey` | Get a full snapshot of a journey — metadata, entries, contributors, and linked trips. |
| `create_journey` | Create a new journey with title, optional subtitle, and an initial list of trip IDs. |
| `update_journey` | Update a journey's title, subtitle, or status. |
| `delete_journey` | Delete a journey. |
| `add_journey_trip` | Link an existing trip to a journey. |
| `remove_journey_trip` | Remove a trip from a journey. |
| `list_journey_entries` | List all entries in a journey (date, text, mood, linked trip). |
| `create_journey_entry` | Add an entry with date (required), optional title, story text, time of day, location name, mood, and sort order. |
| `update_journey_entry` | Edit a journey entry's title, story, date, time of day, or mood. |
| `delete_journey_entry` | Remove an entry from a journey. |
| `reorder_journey_entries` | Reorder entries by providing the new ordered list of entry IDs. |
| `list_journey_contributors` | List the contributors of a journey (owner and editors/viewers). |
| `add_journey_contributor` | Invite a user to a journey with `editor` or `viewer` role. |
| `update_journey_contributor_role` | Change a contributor's role between `editor` and `viewer`. |
| `remove_journey_contributor` | Remove a contributor from a journey. |
| `update_journey_preferences` | Update display preferences for a journey. |
| `get_journey_suggestions` | Get suggested trips to add to journeys based on recent trip history. |
| `list_journey_available_trips` | List all trips available to the current user for linking to a journey. |
| `get_journey_share_link` | Get the current public share link for a journey. Requires `journey:share`. |
| `create_journey_share_link` | Create or update the public share link for a journey. Requires `journey:share`. |
| `delete_journey_share_link` | Revoke the public share link for a journey. Requires `journey:share`. |

---

## Addon-gated resources

Resources provide read-only access via `trek://` URIs. The following resources require their addon to be enabled.

| URI | Addon | Scope required | Description |
|---|---|---|---|
| `trek://trips/{tripId}/budget` | Budget | `budget:read` | Budget and expense items |
| `trek://trips/{tripId}/budget/per-person` | Budget | `budget:read` | Per-person totals and split breakdown |
| `trek://trips/{tripId}/budget/settlement` | Budget | `budget:read` | Suggested transactions to settle who owes whom |
| `trek://trips/{tripId}/packing` | Packing | `packing:read` | Packing checklist |
| `trek://trips/{tripId}/packing/bags` | Packing | `packing:read` | Packing bags with their assigned members |
| `trek://trips/{tripId}/todos` | Packing | `todos:read` | To-do items ordered by position |
| `trek://trips/{tripId}/collab-notes` | Collab | `collab:read` | Shared collaborative notes |
| `trek://bucket-list` | Atlas | `atlas:read` | Your personal travel bucket list |
| `trek://visited-countries` | Atlas | `atlas:read` | Countries marked as visited in Atlas |
| `trek://atlas/stats` | Atlas | `atlas:read` | Visited country counts and continent breakdown |
| `trek://atlas/regions` | Atlas | `atlas:read` | Manually visited sub-country regions |
| `trek://trips/{tripId}/collab/polls` | Collab | `collab:read` | All polls for a trip with vote counts per option |
| `trek://trips/{tripId}/collab/messages` | Collab | `collab:read` | Most recent 100 chat messages for a trip |
| `trek://vacay/plan` | Vacay | `vacay:read` | Full snapshot of your active vacation plan (members, years, config) |
| `trek://vacay/entries/{year}` | Vacay | `vacay:read` | All vacation day entries for the active plan and a specific year |
| `trek://vacay/holidays/{year}` | Vacay | `vacay:read` | Public holidays for the plan's configured region and year |
| `trek://journeys` | Journey | `journey:read` | All journeys owned or contributed to by the current user |
| `trek://journeys/{journeyId}` | Journey | `journey:read` | Single journey with entries, contributors, and linked trips |
| `trek://journeys/{journeyId}/entries` | Journey | `journey:read` | All entries in a journey (date, text, mood, linked trip) |
| `trek://journeys/{journeyId}/contributors` | Journey | `journey:read` | Contributors (owner and collaborators) of a journey |

---

## Related

- [MCP-Tools-and-Resources](MCP-Tools-and-Resources)
- [MCP-Scopes](MCP-Scopes)
- [MCP-Prompts](MCP-Prompts)
- [MCP-Setup](MCP-Setup)
