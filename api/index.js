const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');

// Ensure env vars from backend/.env.local are loaded when running locally
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Firebase Admin SDK Initialization ---
let db;
let rtdb;

if (!admin.apps.length) {
  try {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountRaw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    }

    // Robust parse: try direct JSON.parse, otherwise strip surrounding quotes and retry.
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
    } catch (parseErr) {
      // remove surrounding quotes if present and unescape common sequences
      const stripped = serviceAccountRaw.replace(/^\s*"(.*)"\s*$/s, '$1').replace(/\\n/g, '\n');
      try {
        serviceAccount = JSON.parse(stripped);
      } catch (finalErr) {
        throw new Error('Unable to parse FIREBASE_SERVICE_ACCOUNT_KEY as JSON.');
      }
    }

    const projectId = serviceAccount.project_id;
    // compute databaseURL locally (do not overwrite process.env unless you want to)
    const databaseURL = process.env.FIREBASE_DATABASE_URL || (projectId ? `https://${projectId}.firebaseio.com` : null);
    if (!databaseURL) {
      throw new Error('FIREBASE_DATABASE_URL not set and service account missing project_id. Set FIREBASE_DATABASE_URL explicitly.');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin SDK. Check your environment variables (FIREBASE_SERVICE_ACCOUNT_KEY and FIREBASE_DATABASE_URL).", error);
    // Fail fast so the app doesn't continue with an uninitialized admin instance
    throw error;
  }
}

db = admin.firestore();
try {
  rtdb = admin.database();
} catch (err) {
  console.error('Realtime Database not available:', err);
  rtdb = null;
}

// Helper to return either a real RTDB ref or a no-op ref (prevents runtime crashes if RTDB isn't available)
function getRtdbRef(path) {
  if (!rtdb) {
    return {
      set: async (...args) => { console.warn('RTDB disabled; set ignored for', path, args); },
      update: async (...args) => { console.warn('RTDB disabled; update ignored for', path, args); }
    };
  }
  return rtdb.ref(path);
}

// --- Constants ---
const BATTERY_DRAIN_RATE_PERCENT_PER_SECOND = 2.0;

// --- Helper Function ---
function encodeEmailForRtdb(email) {
  return email.replace(/\./g, ',');
}

// --- Stateless API Endpoints ---

app.post('/api/start', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ message: 'Email is required.' });

  const vehicleFirestoreRef = db.collection('vehicles').doc(email);
  const vehicleRtdbRef = getRtdbRef(`vehicles/${encodeEmailForRtdb(email)}`);

  try {
    await vehicleFirestoreRef.set({
      email,
      isRunning: true,
      notificationSent: false,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await vehicleRtdbRef.set({
      email: email,
      isRunning: true,
      batteryLevel: 100
    });

    res.status(200).send({ message: `EV car simulation started for ${email}.` });
  } catch (error) {
    res.status(500).send({ message: 'Failed to start car.', error: error.message });
  }
});

app.post('/api/stop', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ message: 'Email is required.' });

  const vehicleFirestoreRef = db.collection('vehicles').doc(email);
  const vehicleRtdbRef = getRtdbRef(`vehicles/${encodeEmailForRtdb(email)}`);

  try {
    const vehicleDoc = await vehicleFirestoreRef.get();
    if (!vehicleDoc.exists || !vehicleDoc.data().isRunning) {
        return res.status(400).send({ message: 'Car is not running.' });
    }
    const data = vehicleDoc.data();
    const startTime = data.startTime.toDate();
    const elapsedSeconds = (new Date() - startTime) / 1000;
    const batteryDrained = elapsedSeconds * BATTERY_DRAIN_RATE_PERCENT_PER_SECOND;
    const finalBatteryLevel = Math.max(0, Math.round(100 - batteryDrained));

    await vehicleFirestoreRef.update({
      isRunning: false,
      batteryLevel: finalBatteryLevel,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await vehicleRtdbRef.update({
      isRunning: false,
      batteryLevel: finalBatteryLevel
    });

    res.status(200).send({ message: `EV car stopped for ${email}.` });
  } catch (error) {
    res.status(500).send({ message: 'Failed to stop car.', error: error.message });
  }
});

app.get('/api/status', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).send({ message: 'Email query parameter is required.' });

    const vehicleFirestoreRef = db.collection('vehicles').doc(email);
    const vehicleRtdbRef = getRtdbRef(`vehicles/${encodeEmailForRtdb(email)}`);

    try {
        const vehicleDoc = await vehicleFirestoreRef.get();
        if (!vehicleDoc.exists) {
            return res.status(404).send({ message: 'No vehicle data found for this email.' });
        }

        const data = vehicleDoc.data();
        
        if (!data.isRunning) {
            return res.status(200).send({
                email: data.email,
                isRunning: false,
                batteryLevel: data.batteryLevel || 0
            });
        }
        
        const startTime = data.startTime.toDate();
        const elapsedSeconds = (new Date() - startTime) / 1000;
        const batteryDrained = elapsedSeconds * BATTERY_DRAIN_RATE_PERCENT_PER_SECOND;
        const currentBatteryLevel = Math.max(0, Math.round(100 - batteryDrained));

        await vehicleRtdbRef.update({ 
          batteryLevel: currentBatteryLevel
        });

        if (currentBatteryLevel <= 20 && !data.notificationSent) {
            await sendLowBatteryNotification(email, currentBatteryLevel);
            await vehicleFirestoreRef.update({ notificationSent: true });
        }

        if (currentBatteryLevel <= 0) {
            await vehicleFirestoreRef.update({ isRunning: false, batteryLevel: 0 });
            await vehicleRtdbRef.update({ isRunning: false, batteryLevel: 0 });
            return res.status(200).send({ email, isRunning: false, batteryLevel: 0 });
        }

        res.status(200).send({
            email,
            isRunning: true,
            batteryLevel: currentBatteryLevel
        });

    } catch (error) {
        res.status(500).send({ message: 'Failed to get status.', error: error.message });
    }
});

async function sendLowBatteryNotification(email, batteryLevel) {
  try {
    const userDoc = await db.collection('users').doc(email).get();
    if (!userDoc.exists) return;
    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) return;

    const message = {
      notification: {
        title: 'Low Battery Alert!',
        body: `Your EV's battery is at ${batteryLevel}%. Find a charging station soon.`
      },
      data: { screen: 'charging_station_finder' },
      token: fcmToken
    };
    await admin.messaging().send(message);
    console.log(`Successfully sent low battery notification to ${email}`);
  } catch (error) {
    console.error(`Error sending push notification to ${email}:`, error);
  }
}

// Export the app for Vercel
module.exports = app;