import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { lookupFlight, hasFlightApiKey } from '../services/flightService';

const router = Router();

const LookupQuerySchema = z.object({
  flight_number: z.string().min(2).max(12),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
});

router.get('/lookup', authenticate, async (req: Request, res: Response) => {
  const parsed = LookupQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
    return;
  }
  const { flight_number, date } = parsed.data;
  const userId = (req as AuthRequest).user.id;

  if (!hasFlightApiKey(userId)) {
    res.status(404).json({ error: 'No Flight API key configured. Add your AeroDataBox key in Admin Settings.' });
    return;
  }

  try {
    const result = await lookupFlight(flight_number, date, userId);
    if (!result) {
      res.status(404).json({ error: 'Flight not found for the given number and date.' });
      return;
    }
    res.json({ flight: result });
  } catch {
    res.status(502).json({ error: 'Failed to reach flight data provider. Please try again.' });
  }
});

export default router;
