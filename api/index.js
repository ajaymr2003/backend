const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Firebase Admin SDK Initialization ---
// IMPORTANT: For Vercel, use environment variables, not a file.
if (!admin.apps.length) { // Prevent re-initialization
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } catch (error) {
    console.error("Error initializing Firebase Admin SDK:", error);
  }
}

const db = admin.firestore();

// --- Constants ---
const BATTERY_DRAIN_RATE_PERCENT_PER_SECOND = 0.5; // 1% every 2 seconds

// --- Stateless API Endpoints ---

// POST /start: Starts the car simulation
app.post('/start', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ message: 'Email is required.' });

  const vehicleRef = db.collection('vehicles').doc(email);
  try {
    await vehicleRef.set({
      email,
      isRunning: true,
      batteryLevel: 100,
      notificationSent: false,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(200).send({ message: `EV car simulation started for ${email}.` });
  } catch (error) {
    res.status(500).send({ message: 'Failed to start car.', error: error.message });
  }
});

// POST /stop: Stops the car simulation
app.post('/stop', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ message: 'Email is required.' });

  const vehicleRef = db.collection('vehicles').doc(email);
  try {
    // We need to calculate final battery level before stopping
    const vehicleDoc = await vehicleRef.get();
    if (!vehicleDoc.exists || !vehicleDoc.data().isRunning) {
        return res.status(400).send({ message: 'Car is not running.' });
    }
    const data = vehicleDoc.data();
    const startTime = data.startTime.toDate();
    const elapsedSeconds = (new Date() - startTime) / 1000;
    const batteryDrained = elapsedSeconds * BATTERY_DRAIN_RATE_PERCENT_PER_SECOND;
    const finalBatteryLevel = Math.max(0, Math.round(100 - batteryDrained));

    await vehicleRef.update({
      isRunning: false,
      batteryLevel: finalBatteryLevel, // Save the final calculated battery
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).send({ message: `EV car stopped for ${email}.` });
  } catch (error) {
    res.status(500).send({ message: 'Failed to stop car.', error: error.message });
  }
});

// GET /status: Returns the calculated current state of the car
app.get('/status', async (req, res) => {
    const { email } = req.query; // Get email from query parameter
    if (!email) return res.status(400).send({ message: 'Email query parameter is required.' });

    const vehicleRef = db.collection('vehicles').doc(email);
    try {
        const vehicleDoc = await vehicleRef.get();
        if (!vehicleDoc.exists) {
            return res.status(404).send({ message: 'No vehicle data found for this email.' });
        }

        const data = vehicleDoc.data();
        
        if (!data.isRunning) {
            // If car is not running, return its last known state
            return res.status(200).send({
                email: data.email,
                isRunning: false,
                batteryLevel: data.batteryLevel
            });
        }
        
        // If car IS running, calculate the current battery level
        const startTime = data.startTime.toDate();
        const elapsedSeconds = (new Date() - startTime) / 1000;
        const batteryDrained = elapsedSeconds * BATTERY_DRAIN_RATE_PERCENT_PER_SECOND;
        const currentBatteryLevel = Math.max(0, Math.round(100 - batteryDrained));

        // Check for low battery and send notification if needed
        if (currentBatteryLevel <= 20 && !data.notificationSent) {
            await sendLowBatteryNotification(email, currentBatteryLevel);
            await vehicleRef.update({ notificationSent: true }); // Mark as sent
        }

        // If battery is depleted, stop the car
        if (currentBatteryLevel <= 0) {
            await vehicleRef.update({ isRunning: false, batteryLevel: 0 });
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


// Helper function to send notification
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