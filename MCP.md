# MCP Integration

TREK includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets AI
assistants — such as Claude Desktop, Cursor, or any MCP-compatible client — read and modify your trip data through a
structured API.

> **Note:** MCP is an addon that must be enabled by your TREK administrator before it becomes available.

## Table of Contents

- [Setup](#setup)
- [Limitations & Important Notes](#limitations--important-notes)
- [Resources (read-only)](#resources-read-only)
- [Tools (read-write)](#tools-read-write)
- [Example](#example)

---

## Setup

### 1. Enable the MCP addon (admin)

An administrator must first enable the MCP addon from the **Admin Panel > Addons** page. Until enabled, the `/mcp`
endpoint returns `403 Forbidden` and the MCP section does not appear in user settings.

### 2. Create an API token

Once MCP is enabled, go to **Settings > MCP Configuration** and create an API token:

1. Click **Create New Token**
2. Give it a descriptive name (e.g. "Claude Desktop", "Work laptop")
3. **Copy the token immediately** — it is shown only once and cannot be recovered

Each user can create up to **10 tokens**.

### 3. Configure your MCP client

The Settings page shows a ready-to-copy client configuration snippet. For **Claude Desktop**, add the following to your
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trek": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-trek-instance.com/mcp",
        "--header",
        "Authorization: Bearer trek_your_token_here"
      ]
    }
  }
}
```

> The path to `npx` may need to be adjusted for your system (e.g. `C:\PROGRA~1\nodejs\npx.cmd` on Windows).

---

## Limitations & Important Notes

| Limitation                              | Details                                                                                                                                          |
|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| **Admin activation required**           | The MCP addon must be enabled by an admin before any user can access it.                                                                         |
| **Per-user scoping**                    | Each MCP session is scoped to the authenticated user. You can only access trips you own or are a member of.                                      |
| **No image uploads**                    | Cover images cannot be set through MCP. Use the web UI to upload trip covers.                                                                    |
| **Reservations are created as pending** | When the AI creates a reservation, it starts with `pending` status. You must confirm it manually or ask the AI to set the status to `confirmed`. |
| **Demo mode restrictions**              | If TREK is running in demo mode, all write operations through MCP are blocked.                                                                   |
| **Rate limiting**                       | 60 requests per minute per user. Exceeding this returns a `429` error.                                                                           |
| **Session limits**                      | Maximum 5 concurrent MCP sessions per user. Sessions expire after 1 hour of inactivity.                                                          |
| **Token limits**                        | Maximum 10 API tokens per user.                                                                                                                  |
| **Token revocation**                    | Deleting a token immediately terminates all active MCP sessions for that user.                                                                   |
| **Real-time sync**                      | Changes made through MCP are broadcast to all connected clients in real-time via WebSocket, just like changes made through the web UI.           |

---

## Resources (read-only)

Resources provide read-only access to your TREK data. MCP clients can read these to understand the current state before
making changes.

| Resource          | URI                                        | Description                                               |
|-------------------|--------------------------------------------|-----------------------------------------------------------|
| Trips             | `trek://trips`                             | All trips you own or are a member of                      |
| Trip Detail       | `trek://trips/{tripId}`                    | Single trip with metadata and member count                |
| Days              | `trek://trips/{tripId}/days`               | Days of a trip with their assigned places                 |
| Places            | `trek://trips/{tripId}/places`             | All places/POIs saved in a trip                           |
| Budget            | `trek://trips/{tripId}/budget`             | Budget and expense items                                  |
| Packing           | `trek://trips/{tripId}/packing`            | Packing checklist                                         |
| Reservations      | `trek://trips/{tripId}/reservations`       | Flights, hotels, restaurants, etc.                        |
| Day Notes         | `trek://trips/{tripId}/days/{dayId}/notes` | Notes for a specific day                                  |
| Accommodations    | `trek://trips/{tripId}/accommodations`     | Hotels/rentals with check-in/out details                  |
| Members           | `trek://trips/{tripId}/members`            | Owner and collaborators                                   |
| Collab Notes      | `trek://trips/{tripId}/collab-notes`       | Shared collaborative notes                                |
| Categories        | `trek://categories`                        | Available place categories (for use when creating places) |
| Bucket List       | `trek://bucket-list`                       | Your personal travel bucket list                          |
| Visited Countries | `trek://visited-countries`                 | Countries marked as visited in Atlas                      |

---

## Tools (read-write)

TREK exposes **34 tools** organized by feature area. Use `get_trip_summary` as a starting point — it returns everything
about a trip in a single call.

### Trip Summary

| Tool               | Description                                                                                                                                                                                              |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `get_trip_summary` | Full denormalized snapshot of a trip: metadata, members, days with assignments and notes, accommodations, budget totals, packing stats, reservations, and collab notes. Use this as your context loader. |

### Trips

| Tool          | Description                                                                                 |
|---------------|---------------------------------------------------------------------------------------------|
| `list_trips`  | List all trips you own or are a member of. Supports `include_archived` flag.                |
| `create_trip` | Create a new trip with title, dates, currency. Days are auto-generated from the date range. |
| `update_trip` | Update a trip's title, description, dates, or currency.                                     |
| `delete_trip` | Delete a trip. **Owner only.**                                                              |

### Places

| Tool           | Description                                                                       |
|----------------|-----------------------------------------------------------------------------------|
| `create_place` | Add a place/POI with name, coordinates, address, category, notes, website, phone. |
| `update_place` | Update any field of an existing place.                                            |
| `delete_place` | Remove a place from a trip.                                                       |

### Day Planning

| Tool                      | Description                                                                   |
|---------------------------|-------------------------------------------------------------------------------|
| `assign_place_to_day`     | Pin a place to a specific day in the itinerary.                               |
| `unassign_place`          | Remove a place assignment from a day.                                         |
| `reorder_day_assignments` | Reorder places within a day by providing assignment IDs in the desired order. |
| `update_assignment_time`  | Set start/end times for a place assignment (e.g. "09:00" – "11:30").          |
| `update_day`              | Set or clear a day's title (e.g. "Arrival in Paris", "Free day").             |

### Reservations

| Tool                       | Description                                                                                                                                                                                   |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `create_reservation`       | Create a pending reservation. Supports flights, hotels, restaurants, trains, cars, cruises, events, tours, activities, and other types. Hotels can be linked to places and check-in/out days. |
| `update_reservation`       | Update any field including status (`pending` / `confirmed` / `cancelled`).                                                                                                                    |
| `delete_reservation`       | Delete a reservation and its linked accommodation record if applicable.                                                                                                                       |
| `link_hotel_accommodation` | Set or update a hotel reservation's check-in/out day links and associated place.                                                                                                              |

### Budget

| Tool                 | Description                                                  |
|----------------------|--------------------------------------------------------------|
| `create_budget_item` | Add an expense with name, category, and price.               |
| `update_budget_item` | Update an expense's details, split (persons/days), or notes. |
| `delete_budget_item` | Remove a budget item.                                        |

### Packing

| Tool                  | Description                                                  |
|-----------------------|--------------------------------------------------------------|
| `create_packing_item` | Add an item to the packing checklist with optional category. |
| `update_packing_item` | Rename an item or change its category.                       |
| `toggle_packing_item` | Check or uncheck a packing item.                             |
| `delete_packing_item` | Remove a packing item.                                       |

### Day Notes

| Tool              | Description                                                           |
|-------------------|-----------------------------------------------------------------------|
| `create_day_note` | Add a note to a specific day with optional time label and emoji icon. |
| `update_day_note` | Edit a day note's text, time, or icon.                                |
| `delete_day_note` | Remove a note from a day.                                             |

### Collab Notes

| Tool                 | Description                                                                                     |
|----------------------|-------------------------------------------------------------------------------------------------|
| `create_collab_note` | Create a shared note visible to all trip members. Supports title, content, category, and color. |
| `update_collab_note` | Edit a collab note's content, category, color, or pin status.                                   |
| `delete_collab_note` | Delete a collab note and its associated files.                                                  |

### Bucket List

| Tool                      | Description                                                                                |
|---------------------------|--------------------------------------------------------------------------------------------|
| `create_bucket_list_item` | Add a destination to your personal bucket list with optional coordinates and country code. |
| `delete_bucket_list_item` | Remove an item from your bucket list.                                                      |

### Atlas

| Tool                     | Description                                                                    |
|--------------------------|--------------------------------------------------------------------------------|
| `mark_country_visited`   | Mark a country as visited using its ISO 3166-1 alpha-2 code (e.g. "FR", "JP"). |
| `unmark_country_visited` | Remove a country from your visited list.                                       |

---

## Example

Conversation with Claude: https://claude.ai/share/51572203-6a4d-40f8-a6bd-eba09d4b009d

Initial prompt (1st message):

```
I'd like to plan a week-long trip to Kyoto, Japan, arriving April 5 2027
and leaving April 11 2027. It's cherry blossom season so please keep that
in mind when picking spots.

Before writing anything to TREK, do some research: look up what's worth
visiting, figure out a logical day-by-day flow (group nearby spots together
to avoid unnecessary travel), find a well-reviewed hotel in a central
neighbourhood, and think about what kind of food and restaurant experiences
are worth including.

Once you have a solid plan, write the whole thing to TREK:
- Create the trip
- Add all the places you've researched with their real coordinates
- Build out the daily itinerary with sensible visiting times
- Book the hotel as a reservation and link it properly to the accommodation days
- Add any notable restaurant reservations
- Put together a realistic budget in EUR
- Build a packing list suited to April in Kyoto
- Leave a pinned collab note with practical tips (transport, etiquette, money, etc.)
- Add a day note for each day with any important heads-up (early start, crowd
  tips, booking requirements, etc.)
- Mark Japan as visited in my Atlas

Currency: CHF. Use get_trip_summary at the end and give me a quick recap
of everything that was added.
```

PDF of the generated trip: [./docs/TREK-Generated-by-MCP.pdf](./docs/TREK-Generated-by-MCP.pdf)

![trip](./docs/screenshot-trip-mcp.png)