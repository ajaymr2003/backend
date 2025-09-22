// /backend/api/index.js

const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env.local') });

const app = express();
app.use(cors({ origin: ['https://smartevv.vercel.app', 'http://localhost:3000'] }));
app.use(express.json());

// --- Firebase Initialization ---
let db;
let rtdb;
if (!admin.apps.length) { 
    try { 
        const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY; 
        if (!serviceAccountRaw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not set.'); 
        let serviceAccount = JSON.parse(serviceAccountRaw); 
        admin.initializeApp({ 
            credential: admin.credential.cert(serviceAccount), 
            databaseURL: process.env.FIREBASE_DATABASE_URL 
        }); 
    } catch (error) { 
        console.error("Error initializing Firebase Admin SDK.", error); 
        throw error; 
    } 
}
db = admin.firestore();
rtdb = admin.database();

function encodeEmailForRtdb(email) { return email.replace(/\./g, ','); }

// --- NEW: Helper functions for distance calculation ---
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}


// --- Station Routes ---
app.get('/api/stations', async (req, res) => { try { const stationsRef = db.collection('stations'); const snapshot = await stationsRef.orderBy('name').get(); if (snapshot.empty) return res.status(200).json({ stations: [] }); const stations = snapshot.docs.map(doc => { const data = doc.data(); return { id: doc.id, name: data.name, address: data.address, latitude: data.latitude, longitude: data.longitude, slots: data.slots || [] }; }); res.status(200).json({ stations }); } catch (error) { res.status(500).send({ message: 'Failed to fetch stations.', error: error.message }); } });
app.post('/api/stations/:id/slot-update', async (req, res) => {
    const { id } = req.params;
    const { slotIndex, isAvailable } = req.body;
    if (slotIndex === undefined || isAvailable === undefined) { return res.status(400).send({ message: 'slotIndex and isAvailable are required.' }); }
    try {
        const stationRef = db.collection('stations').doc(id);
        const stationDoc = await stationRef.get();
        if (!stationDoc.exists) { return res.status(404).send({ message: `Station with ID ${id} not found.` }); }
        const station = stationDoc.data();
        const slots = station.slots || [];
        if (slotIndex < 0 || slotIndex >= slots.length) { return res.status(400).send({ message: `Invalid slotIndex ${slotIndex}.` }); }
        const updatedSlots = [...slots];
        updatedSlots[slotIndex].isAvailable = Boolean(isAvailable);
        const newAvailableCount = updatedSlots.filter(s => s.isAvailable).length;
        await stationRef.update({ slots: updatedSlots, availableSlots: newAvailableCount });
        res.status(200).send({ message: `Slot ${slotIndex} for station ${id} updated.` });
    } catch (error) {
        console.error(`Error updating slot for station ${id}:`, error);
        res.status(500).send({ message: 'Failed to update slot.', error: error.message });
    }
});
app.post('/api/stations/bulk-slot-update', async (req, res) => {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) { return res.status(400).send({ message: 'Request body must be an array of station updates.' }); }
    try {
        const batch = db.batch();
        updates.forEach(stationUpdate => {
            const { id, slots } = stationUpdate;
            if (id && Array.isArray(slots)) {
                const stationRef = db.collection('stations').doc(id);
                const newAvailableCount = slots.filter(s => s.isAvailable).length;
                batch.update(stationRef, { slots: slots, availableSlots: newAvailableCount });
            }
        });
        await batch.commit();
        res.status(200).send({ message: 'Stations updated successfully in batch.' });
    } catch (error) {
        console.error('Error in bulk slot update:', error);
        res.status(500).send({ message: 'Failed to bulk update station slots.', error: error.message });
    }
});

// --- Navigation Routes ---
app.get('/api/navigation-status', async (req, res) => {
    const { email } = req.query;
    if (!email) {
        return res.status(400).send({ message: 'Email query parameter is required.' });
    }
    try {
        const navRef = db.collection('navigation').doc(email);
        const doc = await navRef.get();
        if (!doc.exists) {
            return res.status(200).json({ isNavigating: false });
        }
        res.status(200).json(doc.data());
    } catch (error) {
        res.status(500).send({ message: 'Failed to fetch navigation status.', error: error.message });
    }
});
app.post('/api/end-navigation', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).send({ message: 'Email is required.' });
    }
    try {
        const navRef = db.collection('navigation').doc(email);
        // MODIFIED: Also clear the arrival flag
        await navRef.update({ isNavigating: false, isRunning: false, vehicleReachedStation: false });
        res.status(200).send({ message: `Navigation request for ${email} has been cleared.` });
    } catch (error) {
        if (error.code === 5) {
            return res.status(200).send({ message: 'No active navigation request to clear.' });
        }
        res.status(500).send({ message: 'Failed to end navigation.', error: error.message });
    }
});


// --- Vehicle simulation routes ---
app.post('/api/update-battery', async (req, res) => {
    const { email, batteryLevel } = req.body;
    if (!email || batteryLevel === undefined) {
        return res.status(400).send({ message: 'Email and batteryLevel are required.' });
    }
    try {
        const vehicleFirestoreRef = db.collection('vehicles').doc(email);
        await vehicleFirestoreRef.update({ batteryLevel: Number(batteryLevel) });
        const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`);
        await vehicleRtdbRef.update({ batteryLevel: Number(batteryLevel) });
        res.status(200).send({ message: `Battery level updated for ${email}.` });
    } catch (error) {
        console.error('Error updating battery level:', error);
        res.status(500).send({ message: 'Failed to update battery level.', error: error.message });
    }
});
app.post('/api/update-location', async (req, res) => {
    const { email, latitude, longitude } = req.body;
    if (!email || latitude === undefined || longitude === undefined) {
        return res.status(400).send({ message: 'Email, latitude, and longitude are required.' });
    }
    try {
        const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`);
        await vehicleRtdbRef.update({ latitude: Number(latitude), longitude: Number(longitude) });
        res.status(200).send({ message: `Location updated for ${email}.` });
    } catch (error) {
        console.error('Error updating location:', error);
        res.status(500).send({ message: 'Failed to update location.', error: error.message });
    }
});
app.post('/api/update-drain-rate', async (req, res) => {
    const { email, drainRate } = req.body;
    if (!email || drainRate === undefined) {
        return res.status(400).send({ message: 'Email and drainRate are required.' });
    }
    try {
        const vehicleFirestoreRef = db.collection('vehicles').doc(email);
        const vehicleDoc = await vehicleFirestoreRef.get();
        if (!vehicleDoc.exists || !vehicleDoc.data().isRunning) {
            return res.status(400).send({ message: 'Cannot update drain rate for a vehicle that is not running.' });
        }
        await vehicleFirestoreRef.update({ drainRate: Number(drainRate) });
        res.status(200).send({ message: `Drain rate updated for ${email}.` });
    } catch (error) {
        console.error('Error updating drain rate:', error);
        res.status(500).send({ message: 'Failed to update drain rate.', error: error.message });
    }
});
app.get('/api/status', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).send({ message: 'Email query parameter is required.' });
    const vehicleFirestoreRef = db.collection('vehicles').doc(email);
    const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`);
    try {
        let status = { isRunning: false, batteryLevel: 100, latitude: null, longitude: null };
        const rtdbSnapshot = await vehicleRtdbRef.get();
        if (rtdbSnapshot.exists()) {
            const rtdbData = rtdbSnapshot.val();
            status.latitude = rtdbData.latitude || null;
            status.longitude = rtdbData.longitude || null;
            status.batteryLevel = rtdbData.batteryLevel ?? 100;
        }
        const vehicleDoc = await vehicleFirestoreRef.get();
        if (!vehicleDoc.exists || !vehicleDoc.data()) return res.status(200).send(status);
        const data = vehicleDoc.data();
        status.isRunning = data.isRunning || false;
        if (!data.isRunning || !data.startTime || data.startBatteryLevel === undefined) {

            // MODIFIED: Check if an arrival message needs to be sent from a previous check
            const navRef = db.collection('navigation').doc(email);
            const navDoc = await navRef.get();
            if (navDoc.exists && navDoc.data().vehicleReachedStation) {
                status.arrivalCompleted = true;
            }
            return res.status(200).send(status);
        }
        
        const drainRate = data.drainRate || 2.0;
        const startTime = data.startTime.toDate();
        const elapsedSeconds = (new Date() - startTime) / 1000;
        const batteryDrained = elapsedSeconds * drainRate;
        let currentBatteryLevel = Math.max(0, Math.round(data.startBatteryLevel - batteryDrained));
        status.isRunning = currentBatteryLevel > 0 && data.isRunning;

        // --- NEW: Arrival Detection Logic ---
        if (status.isRunning && status.latitude && status.longitude) {
            const navRef = db.collection('navigation').doc(email);
            const navDoc = await navRef.get();
            if (navDoc.exists && navDoc.data().isNavigating) {
                const navData = navDoc.data();
                const distanceToDestinationKm = getDistanceFromLatLonInKm(status.latitude, status.longitude, navData.end_lat, navData.end_lng);
                // Check if vehicle is within 50 meters of destination
                if (distanceToDestinationKm < 0.05) {
                    console.log(`Vehicle for ${email} has reached its destination.`);
                    await vehicleFirestoreRef.update({ isRunning: false, batteryLevel: currentBatteryLevel });
                    await vehicleRtdbRef.update({ isRunning: false, batteryLevel: currentBatteryLevel });
                    await navRef.update({ vehicleReachedStation: true });
                    status.isRunning = false;
                    status.arrivalCompleted = true; // Signal to frontend that arrival happened
                }
            }
        }
        // --- END: Arrival Detection Logic ---

        if (Math.abs(currentBatteryLevel - status.batteryLevel) >= 1) {
            status.batteryLevel = currentBatteryLevel;
            await vehicleRtdbRef.update({ batteryLevel: currentBatteryLevel });
        }

        if (currentBatteryLevel <= 20 && !data.notificationSent) {
            await sendLowBatteryNotification(email, currentBatteryLevel);
            await vehicleFirestoreRef.update({ notificationSent: true });
        }
        if (currentBatteryLevel <= 0 && data.isRunning) {
            await vehicleFirestoreRef.update({ isRunning: false, batteryLevel: 0 });
            await vehicleRtdbRef.update({ isRunning: false, batteryLevel: 0 });
            status.isRunning = false;
        }
        res.status(200).send(status);
    } catch (error) {
        if (!res.headersSent) res.status(500).send({ message: 'Failed to get status.', error: error.message });
    }
});
app.get('/api/users', async (req, res) => { try { const usersRef = db.collection('users'); const snapshot = await usersRef.where('role', '==', 'EV User').get(); if (snapshot.empty) return res.status(200).json({ users: [] }); const userEmails = snapshot.docs.map(doc => doc.data().email); res.status(200).json({ users: userEmails }); } catch (error) { res.status(500).send({ message: 'Failed to fetch EV users.', error: error.message }); } });
app.post('/api/start', async (req, res) => {
    const { email, initialBattery, drainRate } = req.body;
    if (!email) return res.status(400).send({ message: 'Email is required.' });
    const vehicleFirestoreRef = db.collection('vehicles').doc(email);
    const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`);
    try {
        const vehicleDoc = await vehicleFirestoreRef.get();
        if (vehicleDoc.exists && vehicleDoc.data().isRunning) return res.status(400).send({ message: 'Car is already running.' });
        
        const startBatteryLevel = initialBattery ? Number(initialBattery) : (vehicleDoc.exists ? (vehicleDoc.data().batteryLevel ?? 100) : 100);
        
        const currentDrainRate = drainRate ? Number(drainRate) : 2.0;
        await vehicleFirestoreRef.set({ email, isRunning: true, notificationSent: false, startTime: admin.firestore.FieldValue.serverTimestamp(), startBatteryLevel: startBatteryLevel, drainRate: currentDrainRate, }, { merge: true });
        await vehicleRtdbRef.update({ isRunning: true, batteryLevel: startBatteryLevel });
        res.status(200).send({ message: `EV car simulation started for ${email}.` });
    } catch (error) {
        res.status(500).send({ message: 'Failed to start car.', error: error.message });
    }
});
app.post('/api/stop', async (req, res) => { const { email } = req.body; if (!email) return res.status(400).send({ message: 'Email is required.' }); const vehicleFirestoreRef = db.collection('vehicles').doc(email); const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`); try { const vehicleDoc = await vehicleFirestoreRef.get(); if (!vehicleDoc.exists || !vehicleDoc.data().isRunning) return res.status(400).send({ message: 'Car is not running.' }); const data = vehicleDoc.data(); if (!data.startTime || data.startBatteryLevel === undefined) { await vehicleFirestoreRef.update({ isRunning: false }); return res.status(400).send({ message: 'Inconsistent car state. Stopping.' }); } const drainRate = data.drainRate || 2.0; const startTime = data.startTime.toDate(); const elapsedSeconds = (new Date() - startTime) / 1000; const batteryDrained = elapsedSeconds * drainRate; const finalBatteryLevel = Math.max(0, Math.round(data.startBatteryLevel - batteryDrained)); await vehicleFirestoreRef.update({ isRunning: false, batteryLevel: finalBatteryLevel }); await vehicleRtdbRef.update({ isRunning: false, batteryLevel: finalBatteryLevel }); res.status(200).send({ message: `EV car stopped for ${email}.` }); } catch (error) { res.status(500).send({ message: 'Failed to stop car.', error: error.message }); } });
app.post('/api/reset', async (req, res) => { const { email } = req.body; if (!email) return res.status(400).send({ message: 'Email is required.' }); const vehicleFirestoreRef = db.collection('vehicles').doc(email); const vehicleRtdbRef = rtdb.ref(`vehicles/${encodeEmailForRtdb(email)}`); try { await vehicleFirestoreRef.set({ email: email, isRunning: false, batteryLevel: 100, notificationSent: false }, { merge: true }); await vehicleRtdbRef.update({ isRunning: false, batteryLevel: 100, latitude: null, longitude: null, locationName: 'Unknown' }); res.status(200).send({ message: `Simulation for ${email} has been reset.` }); } catch (error) { res.status(500).send({ message: 'Failed to reset simulation.', error: error.message }); } });
async function sendLowBatteryNotification(email, batteryLevel) { try { const userDoc = await db.collection('users').doc(email).get(); if (!userDoc.exists) return; const fcmToken = userDoc.data().fcmToken; if (!fcmToken) return; const message = { notification: { title: 'Low Battery Alert!', body: `Your EV's battery is at ${batteryLevel}%. Find a charging station soon.` }, data: { screen: 'charging_station_finder' }, token: fcmToken }; await admin.messaging().send(message); console.log(`Successfully dispatched low battery notification to ${email}`); } catch (error) { console.error(`Error sending push notification to ${email}:`, error); } }


module.exports = app;