import express, { Request, Response } from 'express';
import { db, canAccessTrip } from '../db/database';
import { authenticate } from '../middleware/auth';
import { AuthRequest, Trip, Place } from '../types';
import { getAIConfig, chatCompletion } from '../services/ai';

const router = express.Router({ mergeParams: true });

function getTripContext(tripId: string | number): { trip: Trip; places: Place[] } | null {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as Trip | undefined;
  if (!trip) return null;

  const places = db.prepare(
    'SELECT name, description, address, category_id FROM places WHERE trip_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(tripId) as Place[];

  return { trip, places };
}

// POST /api/trips/:tripId/ai/suggest-packing
router.post('/suggest-packing', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;

  if (!canAccessTrip(tripId, authReq.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const config = getAIConfig();
  if (!config) {
    return res.status(400).json({ error: 'AI is not configured. Ask your admin to set up an AI provider in the admin panel.' });
  }

  const context = getTripContext(tripId);
  if (!context) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const { trip, places } = context;

  const existingItems = db.prepare(
    'SELECT name, category FROM packing_items WHERE trip_id = ?'
  ).all(tripId) as { name: string; category: string | null }[];

  const placeNames = places.map(p => p.name).join(', ');
  const existingItemNames = existingItems.map(i => i.name).join(', ');

  const prompt = `You are a helpful travel packing assistant. Generate a packing list for a trip.

Trip: "${trip.title}"
${trip.start_date ? `Dates: ${trip.start_date} to ${trip.end_date || 'open'}` : 'No dates set'}
${placeNames ? `Destinations/Places: ${placeNames}` : ''}
${existingItemNames ? `Already packed: ${existingItemNames}` : ''}

Generate 10-15 suggested packing items that are NOT already in the list. Group them by category.
Respond ONLY with a JSON array of objects: [{"name": "item name", "category": "Category Name"}]
Do not include any explanation, just the JSON array.`;

  try {
    const result = await chatCompletion(config, [
      { role: 'system', content: 'You are a travel packing assistant. Respond only with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.7, maxTokens: 1000 });

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    const suggestions = JSON.parse(jsonMatch[0]) as { name: string; category: string }[];
    res.json({ suggestions });
  } catch (err: unknown) {
    console.error('AI suggest-packing error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI request failed' });
  }
});

// POST /api/trips/:tripId/ai/suggest-places
router.post('/suggest-places', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { query } = req.body;

  if (!canAccessTrip(tripId, authReq.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const config = getAIConfig();
  if (!config) {
    return res.status(400).json({ error: 'AI is not configured. Ask your admin to set up an AI provider in the admin panel.' });
  }

  const context = getTripContext(tripId);
  if (!context) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const { trip, places } = context;
  const existingPlaceNames = places.map(p => p.name).join(', ');

  const prompt = `You are a travel planning assistant. Suggest places to visit for this trip.

Trip: "${trip.title}"
${trip.start_date ? `Dates: ${trip.start_date} to ${trip.end_date || 'open'}` : ''}
${existingPlaceNames ? `Already planned: ${existingPlaceNames}` : ''}
${query ? `User request: ${query}` : 'Suggest popular attractions, restaurants, and activities.'}

Suggest 5-8 places. Respond ONLY with a JSON array:
[{"name": "Place Name", "description": "Brief 1-sentence description", "category": "restaurant|attraction|activity|shopping|nature"}]
Do not include any explanation, just the JSON array.`;

  try {
    const result = await chatCompletion(config, [
      { role: 'system', content: 'You are a travel planning assistant. Respond only with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.8, maxTokens: 1000 });

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    const suggestions = JSON.parse(jsonMatch[0]) as { name: string; description: string; category: string }[];
    res.json({ suggestions });
  } catch (err: unknown) {
    console.error('AI suggest-places error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI request failed' });
  }
});

// POST /api/trips/:tripId/ai/suggest-itinerary
router.post('/suggest-itinerary', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { dayId } = req.body;

  if (!canAccessTrip(tripId, authReq.user.id)) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const config = getAIConfig();
  if (!config) {
    return res.status(400).json({ error: 'AI is not configured. Ask your admin to set up an AI provider in the admin panel.' });
  }

  const context = getTripContext(tripId);
  if (!context) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const { trip, places } = context;

  let dayInfo = '';
  if (dayId) {
    const day = db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId) as { day_number: number; date: string | null; title: string | null } | undefined;
    if (day) {
      dayInfo = `Day ${day.day_number}${day.date ? ` (${day.date})` : ''}${day.title ? ` - ${day.title}` : ''}`;
    }
  }

  const placeNames = places.map(p => `${p.name}${p.description ? ': ' + p.description : ''}`).join('\n');

  const prompt = `You are a travel itinerary assistant. Create a day plan for this trip.

Trip: "${trip.title}"
${trip.start_date ? `Trip dates: ${trip.start_date} to ${trip.end_date || 'open'}` : ''}
${dayInfo ? `Planning for: ${dayInfo}` : 'Create a general day plan'}
${placeNames ? `Available places:\n${placeNames}` : ''}

Create a suggested day schedule with 4-6 activities. Respond ONLY with a JSON array:
[{"time": "09:00", "activity": "Activity description", "icon": "emoji", "duration_minutes": 60}]
Do not include any explanation, just the JSON array.`;

  try {
    const result = await chatCompletion(config, [
      { role: 'system', content: 'You are a travel itinerary assistant. Respond only with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.7, maxTokens: 1000 });

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    const suggestions = JSON.parse(jsonMatch[0]) as { time: string; activity: string; icon: string; duration_minutes: number }[];
    res.json({ suggestions });
  } catch (err: unknown) {
    console.error('AI suggest-itinerary error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI request failed' });
  }
});

// GET /api/ai/config (admin only)
export const aiConfigRouter = express.Router();

aiConfigRouter.get('/config', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (authReq.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const get = (key: string) =>
    (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || '';

  const apiKey = get('ai_api_key');

  res.json({
    provider: get('ai_provider') || 'openai',
    api_key_set: !!apiKey,
    model: get('ai_model') || '',
    base_url: get('ai_base_url') || '',
  });
});

// PUT /api/ai/config (admin only)
aiConfigRouter.put('/config', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (authReq.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { provider, api_key, model, base_url } = req.body;

  const set = (key: string, val: string) =>
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, val || '');

  if (provider !== undefined) set('ai_provider', provider);
  if (api_key !== undefined) set('ai_api_key', api_key);
  if (model !== undefined) set('ai_model', model);
  if (base_url !== undefined) set('ai_base_url', base_url);

  res.json({ success: true });
});

// POST /api/ai/validate (admin only)
aiConfigRouter.post('/validate', authenticate, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (authReq.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const config = getAIConfig();
  if (!config) {
    return res.json({ valid: false, error: 'No API key configured' });
  }

  try {
    await chatCompletion(config, [
      { role: 'user', content: 'Say "ok" in one word.' },
    ], { temperature: 0.1, maxTokens: 10 });
    res.json({ valid: true });
  } catch (err: unknown) {
    res.json({ valid: false, error: err instanceof Error ? err.message : 'Validation failed' });
  }
});

export default router;
