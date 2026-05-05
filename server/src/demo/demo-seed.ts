import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

function seedDemoData(db: Database.Database): { adminId: number; demoId: number } {
  const ADMIN_USER = process.env.DEMO_ADMIN_USER || 'admin';
  const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL || 'admin@trek.app';
  const ADMIN_PASS = process.env.DEMO_ADMIN_PASS || 'admin12345';
  const DEMO_EMAIL = 'demo@trek.app';
  const DEMO_PASS = 'demo12345';

  // Create admin user if not exists
  let admin = db.prepare('SELECT id FROM users WHERE email = ?').get(ADMIN_EMAIL) as { id: number } | undefined;
  if (!admin) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    const r = db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run(ADMIN_USER, ADMIN_EMAIL, hash, 'admin');
    admin = { id: Number(r.lastInsertRowid) };
    console.log('[Demo] Admin user created');
  } else {
    admin.id = Number(admin.id);
  }

  // Create demo user if not exists
  let demo = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL) as { id: number } | undefined;
  if (!demo) {
    const hash = bcrypt.hashSync(DEMO_PASS, 10);
    const r = db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run('demo', DEMO_EMAIL, hash, 'user');
    demo = { id: Number(r.lastInsertRowid) };
    console.log('[Demo] Demo user created');
  } else {
    demo.id = Number(demo.id);
  }

  // Disable registration in demo mode
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('allow_registration', 'false')").run();

  // Check if admin already has example trips
  const adminTrips = db.prepare('SELECT COUNT(*) as count FROM trips WHERE user_id = ?').get(admin.id) as { count: number };
  if (adminTrips.count > 0) {
    console.log('[Demo] Example trips already exist, ensuring demo membership');
    ensureDemoMembership(db, admin.id, demo.id);
    return { adminId: admin.id, demoId: demo.id };
  }

  console.log('[Demo] Seeding example trips...');
  seedExampleTrips(db, admin.id, demo.id);

  // Auto-save baseline after first seed
  const { saveBaseline, hasBaseline } = require('./demo-reset');
  if (!hasBaseline()) {
    saveBaseline();
  }

  return { adminId: admin.id, demoId: demo.id };
}

function ensureDemoMembership(db: Database.Database, adminId: number, demoId: number): void {
  const trips = db.prepare('SELECT id FROM trips WHERE user_id = ?').all(adminId) as { id: number }[];
  const insertMember = db.prepare('INSERT OR IGNORE INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)');
  for (const trip of trips) {
    insertMember.run(trip.id, demoId, adminId);
  }
}

function seedExampleTrips(db: Database.Database, adminId: number, demoId: number): void {
  const insertTrip = db.prepare('INSERT INTO trips (user_id, title, description, start_date, end_date, currency) VALUES (?, ?, ?, ?, ?, ?)');
  const insertDay = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  const insertPlace = db.prepare('INSERT INTO places (trip_id, name, lat, lng, address, category_id, place_time, duration_minutes, notes, image_url, google_place_id, website, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertAssignment = db.prepare('INSERT INTO day_assignments (day_id, place_id, order_index) VALUES (?, ?, ?)');
  const insertPackingCategory = db.prepare(
    `INSERT OR IGNORE INTO packing_categories (trip_id, name, type, owner_user_id, sort_order) VALUES (?, ?, 'shared', NULL, 0)`
  );
  const lookupPackingCategory = db.prepare(
    `SELECT id FROM packing_categories WHERE trip_id = ? AND name = ? AND type = 'shared'`
  );
  const insertPackingRow = db.prepare('INSERT INTO packing_items (trip_id, name, checked, category_id, sort_order) VALUES (?, ?, ?, ?, ?)');
  // Keeps the seed-data signature stable; resolves category text to a shared category_id.
  const insertPacking = {
    run: (tripId: number, name: string, checked: number, categoryName: string, sortOrder: number) => {
      insertPackingCategory.run(tripId, categoryName);
      const cat = lookupPackingCategory.get(tripId, categoryName) as { id: number };
      insertPackingRow.run(tripId, name, checked, cat.id, sortOrder);
    },
  };
  const insertBudget = db.prepare('INSERT INTO budget_items (trip_id, category, name, total_price, persons, note) VALUES (?, ?, ?, ?, ?, ?)');
  const insertReservation = db.prepare('INSERT INTO reservations (trip_id, day_id, title, reservation_time, confirmation_number, status, type, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMember = db.prepare('INSERT OR IGNORE INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)');
  const insertNote = db.prepare('INSERT INTO day_notes (day_id, trip_id, text, time, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)');

  // Category IDs: 1=Hotel, 2=Restaurant, 3=Attraction, 5=Transport, 7=Bar/Cafe, 8=Beach, 9=Nature, 6=Entertainment

  // --- Trip 1: Tokyo & Kyoto ---
  const trip1 = insertTrip.run(adminId, 'Tokyo & Kyoto', 'Two weeks in Japan — from the neon-lit streets of Tokyo to the serene temples of Kyoto.', '2026-04-15', '2026-04-21', 'JPY');
  const t1 = Number(trip1.lastInsertRowid);

  const t1days: number[] = [];
  for (let i = 0; i < 7; i++) {
    const d = insertDay.run(t1, i + 1, `2026-04-${15 + i}`);
    t1days.push(Number(d.lastInsertRowid));
  }

  const t1places: [number, string, number, number, string, number, string, number, string, string | null, string | null, string | null, string | null][] = [
    [t1, 'Hotel Shinjuku Granbell', 35.6938, 139.7035, '2-14-5 Kabukicho, Shinjuku City, Tokyo 160-0021, Japan', 1, '15:00', 60, 'Check-in from 3 PM. Steps from Shinjuku Station.', null, 'ChIJdaGEJBeMGGARYgt8sLBv6lM', 'https://www.grfranbellhotel.jp/shinjuku/', '+81 3-5155-2666'],
    [t1, 'Senso-ji Temple', 35.7148, 139.7967, '2 Chome-3-1 Asakusa, Taito City, Tokyo 111-0032, Japan', 3, '09:00', 90, 'Oldest temple in Tokyo. Fewer tourists in the early morning.', null, 'ChIJ8T1GpMGOGGARDYGSgpoOdfg', 'https://www.senso-ji.jp/', '+81 3-3842-0181'],
    [t1, 'Shibuya Crossing', 35.6595, 139.7004, '2 Chome-2-1 Dogenzaka, Shibuya City, Tokyo 150-0043, Japan', 3, '18:00', 45, 'World\'s busiest pedestrian crossing. Most impressive at night.', null, 'ChIJLyzOhmyLGGARMKWbl5z6wGg', null, null],
    [t1, 'Tsukiji Outer Market', 35.6654, 139.7707, '4 Chome-16-2 Tsukiji, Chuo City, Tokyo 104-0045, Japan', 2, '08:00', 120, 'Fresh sushi for breakfast! Explore the street food stalls.', null, 'ChIJq2i1dZCLGGAR1TfoBRo25VU', 'https://www.tsukiji.or.jp/', null],
    [t1, 'Meiji Jingu Shrine', 35.6764, 139.6993, '1-1 Yoyogikamizonocho, Shibuya City, Tokyo 151-8557, Japan', 3, '10:00', 75, 'Peaceful oasis in the middle of the city. Walk through the forest to the shrine.', null, 'ChIJ5SuJSByMGGARMg9qOlTFgkc', 'https://www.meijijingu.or.jp/', '+81 3-3379-5511'],
    [t1, 'Akihabara Electric Town', 35.7023, 139.7745, 'Sotokanda, Chiyoda City, Tokyo, Japan', 3, '14:00', 180, 'Electric Town — anime, manga, electronics. Retro gaming shops!', null, 'ChIJGz1usEyMGGAR1mYByqOOJao', null, null],
    [t1, 'Shinkansen to Kyoto', 35.6812, 139.7671, '1 Chome Marunouchi, Chiyoda City, Tokyo 100-0005, Japan', 5, '08:30', 140, 'Nozomi Shinkansen, approx. 2h15. Window seat for Mt. Fuji views!', null, 'ChIJC3Cf2PuLGGAROO00ukl8JwA', null, null],
    [t1, 'Hotel Granvia Kyoto', 34.9856, 135.7580, 'Karasuma-dori Shiokoji-sagaru, Shimogyo-ku, Kyoto 600-8216, Japan', 1, '14:00', 60, 'Right at Kyoto Station. Perfect base for day trips.', null, 'ChIJUf6MDFcIAWARLihjKC9FWDY', 'https://www.granvia-kyoto.co.jp/', '+81 75-344-8888'],
    [t1, 'Fushimi Inari Taisha', 34.9671, 135.7727, '68 Fukakusa Yabunouchicho, Fushimi Ward, Kyoto 612-0882, Japan', 3, '07:00', 150, '10,000 vermillion torii gates. Start early for empty paths!', null, 'ChIJIW0JRbMIAWARPYEzP5LVHGE', 'http://inari.jp/', '+81 75-641-7331'],
    [t1, 'Kinkaku-ji (Golden Pavilion)', 35.0394, 135.7292, '1 Kinkakujicho, Kita Ward, Kyoto 603-8361, Japan', 3, '10:00', 60, 'The golden temple reflected in the mirror pond. Iconic photo spot.', null, 'ChIJvUbrwCCoAWAR5-uyAXPzBHg', null, '+81 75-461-0013'],
    [t1, 'Arashiyama Bamboo Grove', 35.0095, 135.6673, 'Sagatenryuji Susukinobabacho, Ukyo Ward, Kyoto 616-8385, Japan', 9, '09:00', 90, 'Magical bamboo forest. Best visited in the morning before the crowds.', null, 'ChIJFS4EvA6pAWARQsAPVijvW7I', null, null],
    [t1, 'Nishiki Market', 35.0050, 135.7647, 'Nishiki-koji Dori, Nakagyo Ward, Kyoto 604-8054, Japan', 2, '12:00', 90, 'Kyoto\'s kitchen street. Try the matcha ice cream and fresh mochi!', null, 'ChIJ09zzUigJAWARXzIdh1NE3hQ', 'http://www.kyoto-nishiki.or.jp/', null],
    [t1, 'Gion District', 35.0037, 135.7755, 'Gionmachi Minamigawa, Higashiyama Ward, Kyoto 605-0074, Japan', 3, '17:00', 120, 'Historic geisha district. Best chance of spotting a maiko in the evening.', null, 'ChIJ7WWWjfYJAWARGqEHAfXIzgQ', null, null],
  ];

  const t1pIds = t1places.map(p => Number(insertPlace.run(...p).lastInsertRowid));

  // Day 1: Hotel Check-in, Shibuya
  insertAssignment.run(t1days[0], t1pIds[0], 0);
  insertAssignment.run(t1days[0], t1pIds[2], 1);
  insertNote.run(t1days[0], t1, 'Pick up Pocket WiFi at airport', '13:00', 'Info', 0.5);
  // Day 2: Tsukiji, Senso-ji, Akihabara
  insertAssignment.run(t1days[1], t1pIds[3], 0);
  insertAssignment.run(t1days[1], t1pIds[1], 1);
  insertAssignment.run(t1days[1], t1pIds[5], 2);
  // Day 3: Meiji Shrine, free afternoon
  insertAssignment.run(t1days[2], t1pIds[4], 0);
  insertNote.run(t1days[2], t1, 'Explore Harajuku after the shrine', '12:00', 'MapPin', 1);
  // Day 4: Shinkansen to Kyoto, Hotel
  insertAssignment.run(t1days[3], t1pIds[6], 0);
  insertAssignment.run(t1days[3], t1pIds[7], 1);
  insertNote.run(t1days[3], t1, 'Sit on right side for Mt. Fuji views!', '08:30', 'Train', 0.5);
  // Day 5: Fushimi Inari, Nishiki Market
  insertAssignment.run(t1days[4], t1pIds[8], 0);
  insertAssignment.run(t1days[4], t1pIds[11], 1);
  // Day 6: Kinkaku-ji, Arashiyama
  insertAssignment.run(t1days[5], t1pIds[9], 0);
  insertAssignment.run(t1days[5], t1pIds[10], 1);
  // Day 7: Gion
  insertAssignment.run(t1days[6], t1pIds[12], 0);
  insertNote.run(t1days[6], t1, 'Last evening — farewell dinner at Pontocho Alley', '19:00', 'Star', 1);

  // Packing
  const t1packing: [string, number, string, number][] = [
    ['Passport', 1, 'Documents', 0], ['Japan Rail Pass', 1, 'Documents', 1],
    ['Power adapter Type A/B', 0, 'Electronics', 2], ['Camera + charger', 0, 'Electronics', 3],
    ['Comfortable walking shoes', 0, 'Clothing', 4], ['Rain jacket', 0, 'Clothing', 5],
    ['Sunscreen', 0, 'Toiletries', 6], ['Travel first aid kit', 0, 'Toiletries', 7],
    ['Pocket WiFi confirmation', 1, 'Electronics', 8], ['Yen cash', 0, 'Documents', 9],
  ];
  t1packing.forEach(p => insertPacking.run(t1, ...p));

  // Budget
  insertBudget.run(t1, 'Accommodation', 'Hotel Shinjuku (3 nights)', 67500, 2, 'Double room');
  insertBudget.run(t1, 'Accommodation', 'Hotel Granvia Kyoto (4 nights)', 102000, 2, 'Superior room');
  insertBudget.run(t1, 'Transport', 'Flights FRA-NRT return', 180000, 2, 'Lufthansa direct');
  insertBudget.run(t1, 'Transport', 'Japan Rail Pass (7 days)', 57000, 2, 'Ordinary');
  insertBudget.run(t1, 'Food', 'Daily food budget', 52500, 2, 'Approx. 7,500 JPY/day');
  insertBudget.run(t1, 'Activities', 'Temple entries & experiences', 18000, 2, null);

  // Reservations
  insertReservation.run(t1, t1days[0], 'Hotel Shinjuku Check-in', '15:00', 'SG-2026-78432', 'confirmed', 'hotel', 'Shinjuku, Tokyo');
  insertReservation.run(t1, t1days[3], 'Shinkansen Tokyo → Kyoto', '08:30', 'JR-NOZOMI-445', 'confirmed', 'transport', 'Tokyo Station');

  insertMember.run(t1, demoId, adminId);

  // --- Trip 2: Barcelona Long Weekend ---
  const trip2 = insertTrip.run(adminId, 'Barcelona Long Weekend', 'Gaudi, tapas, and Mediterranean vibes — a long weekend in the Catalan capital.', '2026-05-21', '2026-05-24', 'EUR');
  const t2 = Number(trip2.lastInsertRowid);

  const t2days: number[] = [];
  for (let i = 0; i < 4; i++) {
    const d = insertDay.run(t2, i + 1, `2026-05-${21 + i}`);
    t2days.push(Number(d.lastInsertRowid));
  }

  const t2places: [number, string, number, number, string, number, string, number, string, string | null, string | null, string | null, string | null][] = [
    [t2, 'W Barcelona', 41.3686, 2.1920, 'Placa de la Rosa dels Vents 1, 08039 Barcelona, Spain', 1, '14:00', 60, 'Right on the beach. Rooftop bar with panoramic views!', null, 'ChIJKfj5C8yjpBIRCPC3RPI0JO4', 'https://www.marriott.com/hotels/travel/bcnwh-w-barcelona/', '+34 932 95 28 00'],
    [t2, 'Sagrada Familia', 41.4036, 2.1744, 'C/ de Mallorca, 401, 08013 Barcelona, Spain', 3, '10:00', 120, 'Gaudi\'s masterpiece. Book tickets online in advance — sells out fast!', null, 'ChIJk_s92NyipBIRUMnDG8Kq2Js', 'https://sagradafamilia.org/', '+34 932 08 04 14'],
    [t2, 'Park Guell', 41.4145, 2.1527, '08024 Barcelona, Spain', 3, '09:00', 90, 'Mosaic terrace with city views. Book early for the Monumental Zone.', null, 'ChIJ4eQMeOmipBIRb65JRUzGE8k', 'https://parkguell.barcelona/', '+34 934 09 18 31'],
    [t2, 'La Boqueria Market', 41.3816, 2.1717, 'La Rambla, 91, 08001 Barcelona, Spain', 2, '12:00', 75, 'Famous market on La Rambla. Fresh juice, jamon iberico, and seafood!', null, 'ChIJB_RfKcuipBIRkPKW7MzVGKg', 'http://www.boqueria.barcelona/', '+34 933 18 25 84'],
    [t2, 'Barceloneta Beach', 41.3784, 2.1925, 'Passeig Maritim de la Barceloneta, 08003 Barcelona, Spain', 8, '16:00', 120, 'City beach to unwind after sightseeing. Great chiringuitos nearby.', null, 'ChIJAQCl79-ipBIRUKF3myrMYkM', null, null],
    [t2, 'Gothic Quarter', 41.3834, 2.1762, 'Barri Gotic, 08002 Barcelona, Spain', 3, '15:00', 90, 'Medieval lanes, the cathedral, and Placa Reial. Get lost in the alleys!', null, 'ChIJ4_xkvv2ipBIRrK3bdd-lHgo', null, null],
    [t2, 'Casa Batllo', 41.3916, 2.1650, 'Passeig de Gracia, 43, 08007 Barcelona, Spain', 3, '11:00', 75, 'Gaudi\'s dragon house. The facade alone is worth the visit.', null, 'ChIJ-2VKIcaipBIRKK63H5PYjqQ', 'https://www.casabatllo.es/', '+34 932 16 03 06'],
    [t2, 'El Born & Tapas', 41.3856, 2.1825, 'El Born, 08003 Barcelona, Spain', 7, '20:00', 120, 'Trendy neighborhood with the best tapas bars. Try Cal Pep or El Xampanyet!', null, 'ChIJNY56dxuipBIRbqjSczmLvIA', null, null],
  ];

  const t2pIds = t2places.map(p => Number(insertPlace.run(...p).lastInsertRowid));

  // Day 1: Arrival, Beach, El Born
  insertAssignment.run(t2days[0], t2pIds[0], 0);
  insertAssignment.run(t2days[0], t2pIds[4], 1);
  insertAssignment.run(t2days[0], t2pIds[7], 2);
  // Day 2: Sagrada Familia, Casa Batllo, La Boqueria
  insertAssignment.run(t2days[1], t2pIds[1], 0);
  insertAssignment.run(t2days[1], t2pIds[6], 1);
  insertAssignment.run(t2days[1], t2pIds[3], 2);
  insertNote.run(t2days[1], t2, 'Tickets already booked for 10:00 AM slot', '09:30', 'Ticket', 0.5);
  // Day 3: Park Guell, Gothic Quarter
  insertAssignment.run(t2days[2], t2pIds[2], 0);
  insertAssignment.run(t2days[2], t2pIds[5], 1);
  // Day 4: Beach morning, departure
  insertAssignment.run(t2days[3], t2pIds[4], 0);
  insertNote.run(t2days[3], t2, 'Flight departs at 18:30 — leave hotel by 15:00', '14:00', 'Plane', 1);

  // Packing
  ['Passport', 'Sunscreen SPF50', 'Swimwear', 'Sunglasses', 'Comfortable sandals', 'Beach towel'].forEach((name, i) => {
    insertPacking.run(t2, name, 0, i < 1 ? 'Documents' : 'Summer', i);
  });

  // Budget
  insertBudget.run(t2, 'Accommodation', 'W Barcelona (3 nights)', 780, 2, 'Sea View Room');
  insertBudget.run(t2, 'Transport', 'Flights BER-BCN return', 180, 2, 'Eurowings');
  insertBudget.run(t2, 'Food', 'Restaurants & tapas', 300, 2, 'Approx. 75 EUR/day');
  insertBudget.run(t2, 'Activities', 'Sagrada Familia + Park Guell + Casa Batllo', 95, 2, 'Online tickets');

  insertReservation.run(t2, t2days[1], 'Sagrada Familia Entry', '10:00', 'SF-2026-11234', 'confirmed', 'activity', 'Eixample, Barcelona');

  insertMember.run(t2, demoId, adminId);

  // --- Trip 3: New York City ---
  const trip3 = insertTrip.run(adminId, 'New York City', 'The city that never sleeps — iconic landmarks, world-class food, and Broadway lights.', '2026-09-18', '2026-09-22', 'USD');
  const t3 = Number(trip3.lastInsertRowid);

  const t3days: number[] = [];
  for (let i = 0; i < 5; i++) {
    const d = insertDay.run(t3, i + 1, `2026-09-${18 + i}`);
    t3days.push(Number(d.lastInsertRowid));
  }

  const t3places: [number, string, number, number, string, number, string, number, string, string | null, string | null, string | null, string | null][] = [
    [t3, 'The Plaza Hotel', 40.7645, -73.9744, '768 5th Ave, New York, NY 10019, USA', 1, '15:00', 60, 'Iconic luxury hotel on Central Park. The lobby alone is worth a visit.', null, 'ChIJYbISlAVYwokRn6ORbSPV0xk', 'https://www.theplazany.com/', '+1 212-759-3000'],
    [t3, 'Statue of Liberty', 40.6892, -74.0445, 'Liberty Island, New York, NY 10004, USA', 3, '09:00', 180, 'Book crown access tickets months in advance. Ferry from Battery Park.', null, 'ChIJPTacEpBQwokRKwIlDXelxkA', 'https://www.nps.gov/stli/', '+1 212-363-3200'],
    [t3, 'Central Park', 40.7829, -73.9654, 'Central Park, New York, NY 10024, USA', 9, '10:00', 120, 'Bethesda Fountain, Bow Bridge, and Strawberry Fields. Rent bikes!', null, 'ChIJ4zGFAZpYwokRGUGph3Mf37k', 'https://www.centralparknyc.org/', null],
    [t3, 'Times Square', 40.7580, -73.9855, 'Manhattan, NY 10036, USA', 3, '19:00', 60, 'The crossroads of the world. Best experienced at night with all the lights.', null, 'ChIJmQJIxlVYwokRLgeuocVOGVU', 'https://www.timessquarenyc.org/', null],
    [t3, 'Empire State Building', 40.7484, -73.9857, '350 5th Ave, New York, NY 10118, USA', 3, '11:00', 90, '86th floor observation deck. Go at sunset for the best views.', null, 'ChIJaXQRs6lZwokRY6EFpJnhNNE', 'https://www.esbnyc.com/', '+1 212-736-3100'],
    [t3, 'Brooklyn Bridge', 40.7061, -73.9969, 'Brooklyn Bridge, New York, NY 10038, USA', 3, '16:00', 75, 'Walk from Manhattan to Brooklyn. DUMBO has great pizza and views.', null, 'ChIJK3vOQyNawokRXEYwET2GUtY', null, null],
    [t3, 'The Metropolitan Museum of Art', 40.7794, -73.9632, '1000 5th Ave, New York, NY 10028, USA', 3, '10:00', 180, 'One of the world\'s greatest art museums. Could spend days here.', null, 'ChIJb8Jg766MwokR1YWG0nV7k-E', 'https://www.metmuseum.org/', '+1 212-535-7710'],
    [t3, 'Joe\'s Pizza', 40.7309, -73.9969, '7 Carmine St, New York, NY 10014, USA', 2, '13:00', 30, 'New York\'s most famous pizza slice. Cash only, always a line, always worth it.', null, 'ChIJrfCL1IZZwokRwO3NKN22ZBc', 'http://www.joespizzanyc.com/', '+1 212-366-1182'],
    [t3, 'Top of the Rock', 40.7593, -73.9794, '30 Rockefeller Plaza, New York, NY 10112, USA', 3, '17:30', 60, 'Better views than Empire State because you can SEE the Empire State.', null, 'ChIJ_y2Fb1JYwokRT_iGzhTLdBo', 'https://www.topoftherocknyc.com/', '+1 212-698-2000'],
    [t3, 'Chelsea Market', 40.7424, -74.0061, '75 9th Ave, New York, NY 10011, USA', 2, '12:00', 90, 'Food hall in a converted factory. Lobster rolls, tacos, doughnuts, and more.', null, 'ChIJw2FNFyZZwokRcP9th_vIbkE', 'https://www.chelseamarket.com/', null],
    [t3, 'Broadway Show', 40.7590, -73.9845, 'Broadway, Manhattan, NY 10019, USA', 6, '20:00', 150, 'Can\'t visit NYC without seeing a show. Book TKTS booth for discounts.', null, 'ChIJMYQhxFtYwokR7cJBcNqfKDY', null, null],
  ];

  const t3pIds = t3places.map(p => Number(insertPlace.run(...p).lastInsertRowid));

  // Day 1: Arrival, Times Square, Broadway
  insertAssignment.run(t3days[0], t3pIds[0], 0);
  insertAssignment.run(t3days[0], t3pIds[3], 1);
  insertAssignment.run(t3days[0], t3pIds[10], 2);
  // Day 2: Statue of Liberty, Brooklyn Bridge, Joe's Pizza
  insertAssignment.run(t3days[1], t3pIds[1], 0);
  insertAssignment.run(t3days[1], t3pIds[5], 1);
  insertAssignment.run(t3days[1], t3pIds[7], 2);
  insertNote.run(t3days[1], t3, 'First ferry at 8:30 AM — arrive early at Battery Park', '08:00', 'Ship', 0.5);
  // Day 3: Central Park, Met Museum, Top of the Rock sunset
  insertAssignment.run(t3days[2], t3pIds[2], 0);
  insertAssignment.run(t3days[2], t3pIds[6], 1);
  insertAssignment.run(t3days[2], t3pIds[8], 2);
  // Day 4: Empire State Building, Chelsea Market, shopping
  insertAssignment.run(t3days[3], t3pIds[4], 0);
  insertAssignment.run(t3days[3], t3pIds[9], 1);
  insertNote.run(t3days[3], t3, 'SoHo and 5th Avenue shopping in the afternoon', '14:00', 'ShoppingBag', 1.5);
  // Day 5: Free morning, departure
  insertNote.run(t3days[4], t3, 'Flight departs JFK at 17:00 — last bagel at Russ & Daughters!', '10:00', 'Plane', 0);

  // Packing
  const t3packing: [string, number, string, number][] = [
    ['Passport', 1, 'Documents', 0], ['ESTA confirmation', 1, 'Documents', 1],
    ['Travel insurance', 0, 'Documents', 2], ['Comfortable sneakers', 0, 'Clothing', 3],
    ['Light jacket', 0, 'Clothing', 4], ['Portable charger', 0, 'Electronics', 5],
    ['Camera', 0, 'Electronics', 6], ['Subway card (OMNY)', 0, 'Transport', 7],
  ];
  t3packing.forEach(p => insertPacking.run(t3, ...p));

  // Budget
  insertBudget.run(t3, 'Accommodation', 'The Plaza Hotel (4 nights)', 2400, 2, 'Park View Room');
  insertBudget.run(t3, 'Transport', 'Flights FRA-JFK return', 850, 2, 'United Airlines');
  insertBudget.run(t3, 'Food', 'Daily food budget', 500, 2, 'Approx. 100 USD/day');
  insertBudget.run(t3, 'Activities', 'Statue of Liberty + Empire State + Top of the Rock + Met', 180, 2, 'CityPASS');
  insertBudget.run(t3, 'Entertainment', 'Broadway show tickets', 300, 2, 'Hamilton or Wicked');

  insertReservation.run(t3, t3days[0], 'The Plaza Hotel Check-in', '15:00', 'PZ-2026-55891', 'confirmed', 'hotel', '768 5th Ave, New York');
  insertReservation.run(t3, t3days[0], 'Broadway Show', '20:00', 'BW-HAM-2026-1192', 'pending', 'activity', 'Richard Rodgers Theatre');
  insertReservation.run(t3, t3days[1], 'Statue of Liberty Ferry', '08:30', 'SOL-2026-3347', 'confirmed', 'transport', 'Battery Park');

  insertMember.run(t3, demoId, adminId);

  console.log('[Demo] 3 example trips seeded and shared with demo user');
}

export { seedDemoData };
