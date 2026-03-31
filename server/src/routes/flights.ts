import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fetchFlightData } from '../services/flightService';

const router = express.Router();

router.get('/search', authenticate, async (req: Request, res: Response) => {
  const { number, date } = req.query;

  if (!number || !date) {
    return res.status(400).json({ error: 'Flight number and date are required' });
  }

  try {
    const flights = await fetchFlightData(String(number), String(date));
    res.json({ flights });
  } catch (error: any) {
    console.error('[FlightSearch] Error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to search for flights' });
  }
});

export default router;
