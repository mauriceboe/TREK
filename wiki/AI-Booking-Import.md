# AI Booking Import

The **AI Parsing** addon adds a large-language-model fallback to TREK's booking import. When [KDE Itinerary](Reservations-and-Bookings#import-from-booking-confirmation) can't read a confirmation — a plain-text email, an unusual PDF layout, a vendor whose format it doesn't recognise — TREK can hand the document to an AI model and turn it into a reservation you review before saving.

It is an **opt-in addon, disabled by default**, and it works with a self-hosted local model, so no booking data has to leave your server.

> **Admin:** Enable **AI Parsing** in [Admin-Addons](Admin-Addons) (it sits in the *Integration* group). Booking import then works even without the `kitinerary-extractor` binary — with no extractor present the model parses every uploaded file instead of only the ones Itinerary can't read. Installing the extractor is still the better setup: structured tickets stay fast and deterministic and the model remains a fallback. Configure a provider and model before pointing anyone at it, though: the **Import from file** button appears as soon as the addon is on, and with neither an extractor nor a configured model the import fails outright. See [Reservations-and-Bookings](Reservations-and-Bookings#import-from-booking-confirmation).

## How it fits with normal import

AI parsing does not replace [KDE Itinerary](Reservations-and-Bookings) — it backs it up:

1. Every uploaded file is parsed by KDE Itinerary first.
2. Only files that Itinerary returns **nothing** for are sent to the AI model.
3. Because LLM extraction is less certain, every reservation the AI produces is marked for review internally, and the import walks you through the normal editor item by item to confirm and correct it before it is saved. The mark never becomes a visible badge: the review editor saves each booking as reviewed, so a saved AI import carries no **Review** flag.

So structured tickets keep being parsed the fast, deterministic way; the AI only steps in for the documents that would otherwise fail. If the addon is disabled, import behaves exactly as before. On an install without the extractor there is nothing to back up — every file goes straight to the model.

## Choosing a provider

The addon supports three providers:

| Provider | Runs where | Notes |
|----------|-----------|-------|
| **Local (Ollama)** | Your own hardware | No booking data leaves your network. Recommended for privacy; works on CPU. |
| **OpenAI** | OpenAI's API, or any **OpenAI-compatible** endpoint via a custom base URL | Needs an API key. |
| **Anthropic** | Anthropic's API | Needs an API key. **Reads PDFs — including scans — natively.** |

> **Scanned PDFs:** Local and OpenAI-compatible models receive the document's *extracted text*. A scanned or image-only PDF has no text layer, so those providers return nothing for it. Only **Anthropic** ingests the raw PDF and can read scans.

## Admin: instance-wide configuration

When you enable the addon, a configuration panel appears directly under it in [Admin-Addons](Admin-Addons):

> *Set instance-wide config (applies to all users). Leave blank to let each user configure their own provider.*

- **Provider** — Local · OpenAI-compatible, OpenAI, or Anthropic.
- **Base URL** — shown for every provider except Anthropic. Defaults to `http://localhost:11434/v1` for a local Ollama server, or `https://api.openai.com/v1` for OpenAI. Point it at any OpenAI-compatible endpoint here.
- **API key** — optional for a local server (`(often not required)`), required for the cloud providers. Stored **encrypted**; it is shown masked (`••••••••`) once saved, and leaving it unchanged keeps the stored key.
- **Model** — the model id (e.g. `qwen3:8b`, `gpt-4o`, `claude-opus-4-8`).

If you set a provider and model here, it applies to **all users** and overrides their personal settings. Leave the panel blank to let each user bring their own model (see below).

### Pulling a local model

With the **Local** provider selected, the panel manages your Ollama server directly:

- **Installed on the server** lists the models Ollama already has, with a **Refresh** button. Click a model to select it.
- **Pull a recommended model** downloads a model with a live progress bar. The one recommended model is **Qwen3 — 8B** (`qwen3:8b`) — *best extraction quality & speed on CPU (thinking auto-disabled) · Apache-2.0*. Once the pull finishes it is selected automatically.

You can also select any other model already installed on the server, or type a model id by hand.

## Per-user configuration

If an admin leaves the instance config blank, each user can configure their own model under **Settings → Integrations → AI parsing** (the section only appears when the addon is enabled):

> *Choose the AI model used to extract bookings from uploaded files. This applies only when your administrator has not configured a model for the whole instance.*

The fields are a **Provider** (only **OpenAI** or **Anthropic** here), a **Model** id, and an **API key** that is *stored encrypted* (leave blank to keep the current key). There is no personal Base URL: the address this server calls is instance configuration, so a local (Ollama) model can only be set up by an admin on the addon, and the server answers 403 to anyone, admins included, who tries to store a personal base URL or a personal `local` provider.

There is also a **Send documents as images** toggle. It is stored per user, but extraction currently ignores it: only Anthropic is sent the raw PDF, every other provider always gets the extracted text.

> **Precedence:** an admin instance model always wins. Personal settings only take effect when no instance-wide model is configured.

## Importing a booking with AI

The upload flow is the normal booking import — the AI simply runs behind it:

1. In the trip planner, open the **Bookings** tab and click **Import from file**.
2. Drop your files (EML, PDF, PKPass, HTML, TXT — up to 5 files, 10 MB each) onto the upload area.
3. The upload dialog closes right away and a **background widget** (bottom-right) shows *Parsing files…* with a running count. You can keep navigating TREK while it works; the widget survives a page reload and even follows you to other pages.
4. When parsing finishes, click the widget's **Import** button to start the review.
5. Each parsed booking opens **pre-filled in the normal reservation (or transport) editor**, one at a time. Nothing is saved until you confirm each one.

### When nothing is found

If a job finishes with *No reservations could be extracted*, the widget offers a **Try AI parsing** button. It re-uploads the same files in force-AI mode: KDE Itinerary is skipped entirely and every file goes straight to the model. The offer only appears on an empty result, and never on a run that was already forced. If neither an instance-wide nor a personal model is configured, the retry fails with the error on the card instead of starting.

It is a retry, not a different route — on a normal import the model has already seen every file Itinerary returned nothing for, so it is worth pressing mainly when the addon or the model was configured after that job started. There is no way to push a document Itinerary *did* read through the model: as soon as the parse produced any booking at all, the widget shows **Import** and no retry button. Fix such a booking in the review editor instead.

### What gets filled in and created

The model is asked to capture the full booking — including **every leg of a multi-segment flight** — and, on save, TREK wires each item into the trip:

- **Fields** — booking/confirmation code, dates and times, and per type: seat, class, platform, total price and currency; hotels bring their address, rental cars their company, restaurants and events their venue with phone and website.
- **Places** — only a **hotel** booking becomes a trip place. On save the review editor reuses an existing trip place whose name matches; otherwise the reviewed address is geocoded and a new place is created and linked, so the map pin appears. Transport stops are geocoded while the files are parsed, but they are stored on the booking as its **From → To endpoints**, not as trip places — a stop that could not be located is listed as a warning on the parse result and is dropped when you save, so fix it in the review editor first. Restaurant and event venues arrive only as the booking's location text: the editor can link a place that already exists in the trip, but it never creates one for you.
- **Accommodations** — a hotel booking creates the accommodation on the matching check-in/check-out days.
- **Linked cost** — if the [Costs/Budget addon](Budget-Tracking) is enabled and the booking has a price, a linked expense is created. Without that addon, the price stays on the reservation only.
- **Source document** — the uploaded file is attached to the reservation's files.

## Good to know

- **No manual migration**, and the addon is configured in the UI. The one environment variable it reads is `LLM_TIMEOUT_MS` (see [Environment-Variables](Environment-Variables)).
- **Local inference can be slow.** On a CPU-only host a single booking can take tens of seconds to a couple of minutes; TREK allows a model 15 minutes per document by default, which `LLM_TIMEOUT_MS` raises or lowers. Uploads are parsed **one at a time** per user, so several files queue rather than run in parallel.
- **Parse jobs are kept for about 10 minutes** after they finish. Start the review within that window.
- **Privacy** — with the Local provider nothing leaves your network. With OpenAI or Anthropic, the document's text (or, for Anthropic, the PDF itself) is sent to that provider for extraction.
- **API keys are never returned in plaintext** — they are encrypted at rest and only ever shown masked.

## Related pages

- [Reservations-and-Bookings](Reservations-and-Bookings) — the booking import flow this extends
- [Admin-Addons](Admin-Addons) — enabling the addon
- [Budget-Tracking](Budget-Tracking) — linked costs from imported bookings
- [Transport: Flights, Trains, Cars](Transport-Flights-Trains-Cars)
