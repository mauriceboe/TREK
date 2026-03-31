"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSeeds = runSeeds;
function seedCategories(db) {
    try {
        const existingCats = db.prepare('SELECT COUNT(*) as count FROM categories').get();
        if (existingCats.count === 0) {
            const defaultCategories = [
                { name: 'Hotel', color: '#3b82f6', icon: '🏨' },
                { name: 'Restaurant', color: '#ef4444', icon: '🍽️' },
                { name: 'Attraction', color: '#8b5cf6', icon: '🏛️' },
                { name: 'Shopping', color: '#f59e0b', icon: '🛍️' },
                { name: 'Transport', color: '#6b7280', icon: '🚌' },
                { name: 'Activity', color: '#10b981', icon: '🎯' },
                { name: 'Bar/Cafe', color: '#f97316', icon: '☕' },
                { name: 'Beach', color: '#06b6d4', icon: '🏖️' },
                { name: 'Nature', color: '#84cc16', icon: '🌿' },
                { name: 'Other', color: '#6366f1', icon: '📍' },
            ];
            const insertCat = db.prepare('INSERT INTO categories (name, color, icon) VALUES (?, ?, ?)');
            for (const cat of defaultCategories)
                insertCat.run(cat.name, cat.color, cat.icon);
            console.log('Default categories seeded');
        }
    }
    catch (err) {
        console.error('Error seeding categories:', err instanceof Error ? err.message : err);
    }
}
function seedAddons(db) {
    try {
        const defaultAddons = [
            { id: 'packing', name: 'Packing List', description: 'Pack your bags with checklists per trip', type: 'trip', icon: 'ListChecks', enabled: 1, sort_order: 0 },
            { id: 'budget', name: 'Budget Planner', description: 'Track expenses and plan your travel budget', type: 'trip', icon: 'Wallet', enabled: 1, sort_order: 1 },
            { id: 'documents', name: 'Documents', description: 'Store and manage travel documents', type: 'trip', icon: 'FileText', enabled: 1, sort_order: 2 },
            { id: 'vacay', name: 'Vacay', description: 'Personal vacation day planner with calendar view', type: 'global', icon: 'CalendarDays', enabled: 1, sort_order: 10 },
            { id: 'atlas', name: 'Atlas', description: 'World map of your visited countries with travel stats', type: 'global', icon: 'Globe', enabled: 1, sort_order: 11 },
            { id: 'collab', name: 'Collab', description: 'Notes, polls, and live chat for trip collaboration', type: 'trip', icon: 'Users', enabled: 1, sort_order: 6 },
            { id: 'kosten', name: 'Kosten', description: 'Split expenses and settle debts between trip members', type: 'trip', icon: 'Receipt', enabled: 1, sort_order: 4 },
        ];
        const insertAddon = db.prepare('INSERT OR IGNORE INTO addons (id, name, description, type, icon, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const a of defaultAddons)
            insertAddon.run(a.id, a.name, a.description, a.type, a.icon, a.enabled, a.sort_order);
        console.log('Default addons seeded');
    }
    catch (err) {
        console.error('Error seeding addons:', err instanceof Error ? err.message : err);
    }
}
function runSeeds(db) {
    seedCategories(db);
    seedAddons(db);
}
//# sourceMappingURL=seeds.js.map