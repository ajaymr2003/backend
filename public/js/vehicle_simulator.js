// /backend/public/js/vehicle_simulator.js

const apiUrl = '/api';
let userEmail = null;

// --- State Variables ---
let statusInterval = null;
let animationInterval = null;
let locationUpdateInterval = null;
// let hasFocusedOnVehicle = false; // <-- REMOVED: This flag is no longer needed.

// --- Map Layers ---
let map = null;
let userMarker = null;
let destinationMarker = null;
let vehicleMarker = null;
let routeLine = null;
let routeData = null;

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
        // When a new user is selected, reset the map state completely
        resetSimulationState(); 
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
    await callApi('/start', {
        email: userEmail,
        initialBattery: initialBatterySelect.value,
        drainRate: drainRateSelect.value
    });
    startMovementSimulation(routeData);
});
stopButton.addEventListener('click', () => {
    callApi('/stop', { email: userEmail });
    stopMovementSimulation();
});
resetButton.addEventListener('click', () => {
    callApi('/reset', { email: userEmail });
    resetSimulationState();
});
vehicleSpeedSelect.addEventListener('change', () => {
    if (routeData) {
        displayRouteInfo();
    }
});

// --- Core Functions ---
function updateControlsState(isRunning) {
    userSelect.disabled = isRunning;
    initialBatterySelect.disabled = isRunning;
    drainRateSelect.disabled = isRunning;
    vehicleSpeedSelect.disabled = isRunning;
    resetButton.disabled = isRunning;
    startButton.disabled = isRunning || !routeData;
    stopButton.disabled = !isRunning;
}
async function fetchRoute(startLatLng, endLatLng) {
    const url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?geometries=geojson`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OSRM responded with status ${response.status}`);
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            return {
                coordinates: route.geometry.coordinates.map(coord => [coord[1], coord[0]]),
                distance: route.distance
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
    const timeHours = speedKmh > 0 ? distanceKm / speedKmh : 0;
    const timeMinutes = Math.round(timeHours * 60);
    routeDistanceElem.textContent = distanceKm;
    routeTimeElem.textContent = `${timeMinutes} min`;
    routeInfoElem.style.display = 'block';
}
function startMovementSimulation(currentRouteData) {
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) routeLine.remove();
    const routeCoordinates = currentRouteData.coordinates;
    routeLine = L.polyline(routeCoordinates, { color: '#007bff', weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    const carIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/3039/3039898.png',
        iconSize: [38, 38], iconAnchor: [19, 38]
    });
    vehicleMarker = L.marker(routeCoordinates[0], { icon: carIcon }).addTo(map);
    const distanceMeters = currentRouteData.distance;
    const speedKmh = parseInt(vehicleSpeedSelect.value, 10);
    const speedMps = speedKmh * 1000 / 3600;
    const totalDurationSeconds = speedKmh > 0 ? distanceMeters / speedMps : Infinity;
    const stepInterval = (totalDurationSeconds / routeCoordinates.length) * 1000;
    let currentIndex = 0;
    if (animationInterval) clearInterval(animationInterval);
    animationInterval = setInterval(() => {
        if (currentIndex >= routeCoordinates.length) {
            callApi('/stop', { email: userEmail });
            stopMovementSimulation();
            return;
        }
        vehicleMarker.setLatLng(routeCoordinates[currentIndex]);
        currentIndex++;
    }, stepInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    locationUpdateInterval = setInterval(() => {
        if (vehicleMarker) {
            const { lat, lng } = vehicleMarker.getLatLng();
            updateVehicleLocation(lat, lng);
        }
    }, 1500);
    console.log(`Manual animation started. Steps: ${routeCoordinates.length}, Interval: ${stepInterval.toFixed(2)} ms`);
}
async function onMapClick(e) {
    if (!userEmail) { alert("Please select a user first."); return; }
    if (runningStatusElem.classList.contains('running')) return;
    const { lat, lng } = e.latlng;
    if (!userMarker) {
        // This is the first click, so we CREATE the start marker
        createOrUpdateStartMarker([lat, lng]);
        updateVehicleLocation(lat, lng);
        mapInstruction.innerHTML = "Click map to set the <strong>Destination Point</strong>.";
    } else {
        createOrUpdateDestinationMarker([lat, lng]);
        if (routeLine) { routeLine.remove(); routeLine = null; }
        routeData = await fetchRoute(userMarker.getLatLng(), destinationMarker.getLatLng());
        if (routeData) {
            routeLine = L.polyline(routeData.coordinates, { color: '#007bff', weight: 5, dashArray: '10, 5' }).addTo(map);
            map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
            displayRouteInfo();
            mapInstruction.innerHTML = "Route is set. You can now <strong>Start Ride</strong>.";
        } else {
            routeInfoElem.style.display = 'none';
            if(destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
            mapInstruction.innerHTML = "Could not find a route. Please set a new <strong>Destination Point</strong>.";
        }
    }
    updateControlsState(false);
}
function resetSimulationState() {
    stopMovementSimulation();
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (destinationMarker) { destinationMarker.remove(); destinationMarker = null; }
    if (routeLine) { routeLine.remove(); routeLine = null; }
    routeData = null;
    routeInfoElem.style.display = 'none';
    mapInstruction.innerHTML = "Click map to set vehicle's <strong>Start Point</strong>.";
    getStatus();
}

// --- THIS IS THE MODIFIED FUNCTION ---
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

            // If the simulation on the backend stops (e.g., battery dies),
            // we stop the front-end animation.
            if (!isRunning && vehicleMarker) {
                stopMovementSimulation();
            }

            // --- IMPORTANT CHANGE ---
            // The code that automatically created a start marker has been REMOVED.
            // This function is now only responsible for reporting status,
            // not for changing the map state before the user interacts.
        })
        .catch(console.error);
};

function startPolling() {
    if (statusInterval) clearInterval(statusInterval);
    getStatus();
    statusInterval = setInterval(getStatus, 2000);
}
function stopMovementSimulation() {
    if (animationInterval) clearInterval(animationInterval);
    if (locationUpdateInterval) clearInterval(locationUpdateInterval);
    animationInterval = null;
    locationUpdateInterval = null;
    // When the animation stops, we place a static start marker at its last position.
    // This is correct behavior.
    if (vehicleMarker) {
        const lastPosition = vehicleMarker.getLatLng();
        vehicleMarker.remove();
        vehicleMarker = null;
        createOrUpdateStartMarker(lastPosition);
    }
    getStatus();
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
        getStatus();
        return data;
    } catch (error) {
        console.error(`API Error on ${endpoint}:`, error);
        alert(`Error: ${error.message}`);
    }
}
async function fetchAndDisplayStations() {
    try {
        const res = await fetch(`${apiUrl}/stations`);
        const data = await res.json();
        const stations = Array.isArray(data.stations) ? data.stations : [];
        const stationIcon = L.icon({
            iconUrl: 'https://cdn-icons-png.flaticon.com/512/3448/3448603.png',
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        });
        const stationPositions = [];
        stations.forEach(station => {
            if (station.latitude && station.longitude) {
                const position = [station.latitude, station.longitude];
                L.marker(position, { icon: stationIcon })
                    .addTo(map)
                    .bindPopup(`<b>${station.name}</b>`);
                stationPositions.push(position);
            }
        });
        if (stationPositions.length > 0) {
            const bounds = L.latLngBounds(stationPositions);
            map.fitBounds(bounds, { padding: [50, 50] });
            console.log(`Map view automatically adjusted to show ${stationPositions.length} stations.`);
        } else {
            console.log('No stations found to set initial map view.');
        }
        console.log(`${stations.length} total stations loaded.`);
    } catch (error) {
        console.error('Failed to load stations for map:', error);
    }
}
async function updateVehicleLocation(latitude, longitude) {
    if (!userEmail) return;
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
    mapInstruction.innerHTML = "Select a user, then click the map to set a <strong>Start Point</strong>.";
    updateControlsState(false);
}
initialize();