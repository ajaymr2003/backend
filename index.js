const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
const port = 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Firebase Admin SDK Initialization ---
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
  console.error("Error initializing Firebase Admin SDK. Make sure 'serviceAccountKey.json' is present.");
  process.exit(1); 
}

// --- Firestore Database Reference ---
const db = admin.firestore();

// --- EV Car State (for a single simulated vehicle) ---
let evCar = {
  email: null,
  isRunning: false,
  batteryLevel: 100,
  batteryInterval: null,
  notificationSent: false
};

// --- Core Functions ---

async function updateFirestoreStatus() {
  if (!evCar.email) {
    console.log('No email set, skipping Firestore update.');
    return;
  }
  
  const vehicleRef = db.collection('vehicles').doc(evCar.email);
  
  try {
    await vehicleRef.set({
      batteryLevel: evCar.batteryLevel,
      isRunning: evCar.isRunning,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`Successfully updated Firestore for ${evCar.email}`);
  } catch (error) {
    console.error('Error updating Firestore:', error);
  }
}

function startBatteryReduction() {
  if (evCar.batteryInterval) clearInterval(evCar.batteryInterval);

  evCar.batteryInterval = setInterval(() => {
    if (evCar.isRunning && evCar.batteryLevel > 0) {
      evCar.batteryLevel -= 1;
      console.log(`Battery level: ${evCar.batteryLevel}% for ${evCar.email}`);
      updateFirestoreStatus();

      if (evCar.batteryLevel <= 20 && !evCar.notificationSent) {
        // Call the async function. We don't need to await it here,
        // it can run in the background ("fire-and-forget").
        sendLowBatteryNotification(); 
        evCar.notificationSent = true;
      }
    } else if (evCar.batteryLevel <= 0) {
      console.log('Battery depleted. Stopping car.');
      stopCar();
    }
  }, 500);
}

function stopBatteryReduction() {
  clearInterval(evCar.batteryInterval);
  evCar.batteryInterval = null;
}

function stopCar() {
    evCar.isRunning = false;
    stopBatteryReduction();
    console.log(`EV Car stopped for ${evCar.email}.`);
    updateFirestoreStatus();
}

// =========================================================================
// --- MODIFIED: PUSH NOTIFICATION FUNCTION ---
// =========================================================================
async function sendLowBatteryNotification() {
  if (!evCar.email) {
    console.log("Cannot send notification: No user email is set for the current simulation.");
    return;
  }

  try {
    // 1. Get the user document from Firestore using the email
    const userDocRef = db.collection('users').doc(evCar.email);
    const userDoc = await userDocRef.get();

    // 2. Check if the user document exists
    if (!userDoc.exists) {
      console.log(`Notification failed: User document not found for email ${evCar.email}`);
      return;
    }

    // 3. Get the fcmToken from the document data
    const fcmToken = userDoc.data().fcmToken;

    // 4. Check if the token exists
    if (!fcmToken) {
      console.log(`Notification failed: fcmToken field is missing for user ${evCar.email}`);
      return;
    }

    // 5. Construct the message payload
    const message = {
      notification: {
        title: 'Low Battery Alert!',
        body: `Your EV's battery is at ${evCar.batteryLevel}%. Find a charging station soon.`
      },
      data: {
          batteryLevel: String(evCar.batteryLevel),
          email: evCar.email,
          screen: 'charging_station_finder' // This tells the app where to navigate
      },
      token: fcmToken // Use the token fetched from Firestore
    };

    // 6. Send the message
    const response = await admin.messaging().send(message);
    console.log(`Successfully sent low battery notification to ${evCar.email}:`, response);

  } catch (error) {
    console.error(`Error sending push notification to ${evCar.email}:`, error);
  }
}

// --- API Endpoints ---

app.post('/start', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).send({ message: 'Email is required.' });
  }

  if (evCar.isRunning) {
    return res.status(400).send({ message: `A car is already running for ${evCar.email}. Stop it first.` });
  }

  evCar = {
    ...evCar,
    email: email,
    isRunning: true,
    batteryLevel: 100,
    notificationSent: false
  };
  
  startBatteryReduction();
  updateFirestoreStatus();
  res.status(200).send({ message: `EV car started for ${email}.` });
});

app.post('/stop', (req, res) => {
  if (evCar.isRunning) {
    stopCar();
    res.status(200).send({ message: `EV car stopped for ${evCar.email}.` });
  } else {
    res.status(400).send({ message: 'EV car is not running.' });
  }
});

app.get('/status', (req, res) => {
  const { batteryInterval, ...statusToSend } = evCar;
  res.status(200).send(statusToSend);
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`EV car simulation server listening at http://localhost:${port}`);
});