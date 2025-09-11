// == PASTE THIS ENTIRE CODE INTO YOUR JAVASCRIPT FILE ==

const apiUrl = '/api';
let userEmail = null;

// --- State Variables ---
let statusInterval = null;          // For polling backend status
let animationInterval = null;       // For moving the marker visually
let locationUpdateInterval = null;  // For sending location to backend

// --- Map Layers ---
let map = null;
let userMarker = null;          // Static start marker
let destinationMarker = null;   // Static destination marker
let vehicleMarker = null;       // The moving vehicle marker
let routeLine = null;
let routeData = null;           // Stores {coordinates, distance}

const defaultCenter = [12.9716, 77.5946];

// --- Get all UI elements ---
const userSelect = document.getElementById('userSelect');
const initialBatterySelect = document.getElementById('initialBatterySelect');
const drainRateSelect = document.getElementById('drainRateSelect');
const vehicleSpeedSelect = document.getElementById('vehicleSpeedSelect');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const resetButton = document.getElementById('resetButton');
const mapInstruction = document.getElementById('mapInstruction');
const currentUserElem = document.getElementById('currentUser');
const runningStatusElem = document.getElementById('runningStatus');
const batteryLevelElem = document.getElementById('batteryLevel');
const routeInfoElem = document.getElementById('routeInfo');
const routeDistanceElem = document.getElementById('routeDistance');
const routeTimeElem = document.getElementById('routeTime');


// --- Event Listeners ---

userSelect.addEventListener('change', () => {
    userEmail = userSelect.value;
    if (userEmail) {
        currentUserElem.textContent = userEmail;
        resetButton.disabled = false;
        startPolling();
    }
});

startButton.addEventListener('click', async () => {
    if (!routeData) {
        alert("Please set a valid start and destination point on the map.");
        return;
    }
    // Start the backend simulation first
    await callApi('/start', {
        email: userEmail,
        initialBattery: initialBatterySelect.value,
        drainRate: drainRateSelect.value
    });
    // Then start the visual animation
    startMovementSimulation(routeData);
});

stopButton.addEventListener('click', () => {
    callApi('/stop', { email: userEmail });
    stopMovementSimulation(); // Stop the visual animation
});

resetButton.addEventListener('click', () => {
    callApi('/reset', { email: userEmail });
    resetSimulationState(); // Reset the entire frontend
});

vehicleSpeedSelect.addEventListener('change', () => {
    // If a route is already planned, update the ETA
    if (routeData) {
        displayRouteInfo();
    }
});


// --- Core Functions ---

function updateControlsState(isRunning) {
    // Disable form controls when the simulation is running
    userSelect.disabled = isRunning;
    initialBatterySelect.disabled = isRunning;
    drainRateSelect.disabled = isRunning;
    vehicleSpeedSelect.disabled = isRunning;
    resetButton.disabled = isRunning;

    // Update button states based on running status and if a route is planned
    startButton.disabled = isRunning || !routeData;
    stopButton.disabled = !isRunning;
}

async function fetchRoute(startLatLng, endLatLng) {
    // OSRM API URL for the driving profile
    const url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?geometries=geojson`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OSRM responded with status ${response.status}`);
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            return {
                // OSRM returns [lng, lat], Leaflet needs [lat, lng], so we flip them here.
                coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                distance: route.distance // Distance in meters
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching route from OSRM:", error);
        alert("Could not fetch a route. Please try different points.");
        return null;
    }
}

function displayRouteInfo() {
    if (!routeData) return;

    const distanceKm = (routeData.distance / 1000).toFixed(2);
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    // Calculate time, handling potential division by zero if speed is 0
    const timeHours = speedKmh > 0 ? distanceKm / speedKmh : 0;
    const timeMinutes = Math.round(timeHours * 60);

    routeDistanceElem.textContent = distanceKm;
    routeTimeElem.textContent = `${timeMinutes} min`;
    routeInfoElem.style.display = 'block';
}

/**
 * NEW: Manual Animation Engine
 * This function creates and manages the vehicle's movement without external plugins.
 */
function startMovementSimulation(currentRouteData) {
    // 1. Clean up the map for animation
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) routeLine.remove();

    const routeCoordinates = currentRouteData.coordinates;

    // 2. Draw the solid route line for the active journey
    routeLine = L.polyline(routeCoordinates, { color: '#007bff', weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });

    // 3. Create the vehicle marker
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3039/3039898.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    vehicleMarker = L.marker(routeCoordinates[0], { icon: carIcon }).addTo(map);

    // 4. Calculate animation timing
    const distanceMeters = currentRouteData.distance;
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const speedMps = speedKmh * 1000 / 3600; // Meters per second
    const totalDurationSeconds = distanceMeters / speedMps;
    const stepInterval = (totalDurationSeconds / routeCoordinates.length) * 1000; // Interval in ms

    // 5. Start the animation loop
    let currentIndex = 0;
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = setInterval(() => {
        if (currentIndex >= routeCoordinates.length) {
            // End of the route
            callApi('/stop', { email: userEmail });
            stopMovementSimulation();
            return;
        }

        // Move the marker to the next point on the route
        vehicleMarker.setLatLng(routeCoordinates[currentIndex]);
        currentIndex++;
    }, stepInterval);

    // 6. Start the separate, slower loop for backend updates
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    locationUpdateInterval = setInterval(() => {
        if (vehicleMarker) {
            const { lat, lng } = vehicleMarker.getLatLng();
            updateVehicleLocation(lat, lng);
        }
    }, 1500); // Send update every 1.5 seconds

    console.log(`Manual animation started. Steps: ${routeCoordinates.length}, Interval: ${stepInterval.toFixed(2)} ms`);
}


async function onMapClick(e) {
    if (!userEmail) { alert("Please select a user first."); return; }
    if (runningStatusElem.classList.contains('running')) return;

    const { lat, lng } = e.latlng;

    if (!userMarker) {
        // First click: Set start point
        createOrUpdateStartMarker([lat, lng]);
        updateVehicleLocation(lat, lng);
        mapInstruction.innerHTML = "Click map to set the <strong>Destination Point</strong>.";
    } else {
        // Second click: Set destination and fetch route
        createOrUpdateDestinationMarker([lat, lng]);
        
        if (routeLine) { routeLine.remove(); routeLine = null; }

        routeData = await fetchRoute(userMarker.getLatLng(), destinationMarker.getLatLng());

        if (routeData) {
            // Draw a dashed "preview" route line
            routeLine = L.polyline(routeData.coordinates, { color: '#007bff', weight: 5, dashArray: '10, 5' }).addTo(map);
            map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
            displayRouteInfo();
            mapInstruction.innerHTML = "Route is set. You can now <strong>Start Ride</strong>.";
        } else {
            // Handle route finding failure
            routeInfoElem.style.display = 'none';
            if(destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
            mapInstruction.innerHTML = "Could not find a route. Please set a new <strong>Destination Point</strong>.";
        }
    }
    updateControlsState(false); // Update buttons based on new state
}

function resetSimulationState() {
    stopMovementSimulation(); // Stop any running animations and timers

    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    
    routeData = null;
    routeInfoElem.style.display = 'none';
    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
    
    getStatus(); // Refresh status from backend
}


const getStatus = () => {
    if (!userEmail) return;
    fetch(`${apiUrl}/status?email=${encodeURIComponent(userEmail)}`)
        .then(res => res.json())
        .then(data => {
            const isRunning = data.isRunning;
            runningStatusElem.textContent = isRunning ? 'Running' : 'Not Running';
            runningStatusElem.className = isRunning ? 'running' : 'stopped';
            batteryLevelElem.textContent = `${data.batteryLevel} %`;

            updateControlsState(isRunning);

            // If backend says we are not running, but there is a vehicle marker, stop the animation.
            if (!isRunning && vehicleMarker) {
                stopMovementSimulation();
            }

            // Sync static marker with backend's last known location if not running
            if (!isRunning && data.latitude && data.longitude) {
                createOrUpdateStartMarker([data.latitude, data.longitude]);
            }
        })
        .catch(console.error);
};

function startPolling() {
    if (statusInterval) clearInterval(statusInterval);
    getStatus();
    statusInterval = setInterval(getStatus, 2000);
}

function stopMovementSimulation() {
    // Clear all animation-related intervals
    if (animationInterval) clearInterval(animationInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    animationInterval = null;
    locationUpdateInterval = null;

    if (vehicleMarker) {
        const lastPosition = vehicleMarker.getLatLng();
        vehicleMarker.remove();
        vehicleMarker = null;
        // Place a static marker at the vehicle's last position
        createOrUpdateStartMarker(lastPosition);
    }
    
    getStatus(); // Update UI to reflect the stopped state
}

function initMap() {
    map = L.map('map').setView(defaultCenter, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    map.on('click', onMapClick);
}

function createOrUpdateStartMarker(latlng) {
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/6274/6274953.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    if (userMarker) {
        userMarker.setLatLng(latlng);
    } else {
        userMarker = L.marker(latlng, { icon: carIcon, draggable: true }).addTo(map);
        userMarker.on('dragend', async (event) => {
            if (runningStatusElem.classList.contains('running')) return;
            // When start marker is dragged, re-calculate the route if a destination exists
            if (destinationMarker) {
                onMapClick({ latlng: destinationMarker.getLatLng() });
            }
        });
    }
}

function createOrUpdateDestinationMarker(latlng) {
    const flagIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/157/157233.png',
        iconSize: [38, 38], iconAnchor: [1, 38]
    });
    if (destinationMarker) {
        destinationMarker.setLatLng(latlng);
    } else {
        destinationMarker = L.marker(latlng, { icon: flagIcon, draggable: true }).addTo(map);
        destinationMarker.on('dragend', (event) => {
            // When destination marker is dragged, re-calculate the route
            onMapClick({ latlng: event.target.getLatLng() });
        });
    }
}

async function callApi(endpoint, body) {
    try {
        const response = await fetch(apiUrl + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `API call to ${endpoint} failed`);
        }
        const data = await response.json();
        console.log(`API call to ${endpoint} successful:`, data);
        getStatus(); // Refresh status after every successful API call
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error);
        alert(`Error: ${error.message}`);
    }
}

// Station locations are for display only, as requested.
async function fetchAndDisplayStations() {
    try {
        const res = await fetch(`${apiUrl}/stations`);
        const data = await res.json();
        const stations = Array.isArray(data.stations) ? data.stations : [];
        const stationIcon = L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448603.png',
            iconSize: [32, 32], iconAnchor: [16, 32]
        });
        stations.forEach(station => {
            if (station.latitude && station.longitude) {
                L.marker([station.latitude, station.longitude], { icon: stationIcon })
                 .addTo(map)
                 .bindPopup(`<b>${station.name}</b>`);
            }
        });
        console.log(`${stations.length} stations loaded.`);
    } catch (error) {
        console.error('Failed to load stations for map:', error);
    }
}

async function updateVehicleLocation(latitude, longitude) {
    if (!userEmail) return;
    // This function can now be simpler, just sending the data.
    // The `getStatus` call is handled by the main `callApi` function.
    await callApi('/update-location', {
        email: userEmail,
        latitude,
        longitude
    });
}

async function initialize() {
    initMap();
    await fetchAndDisplayStations();
    try {
        const userRes = await fetch(`${apiUrl}/users`);
        const userData = await userRes.json();
        userSelect.innerHTML = '<option value="" disabled selected>Select a User</option>';
        (userData.users || []).forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            option.textContent = email;
            userSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load users:', error);
    }
    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
    updateControlsState(false);
}

// Start the application
initialize();